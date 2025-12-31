import { RouterInstance } from '@koa/router';
import { ParameterizedContext } from 'koa';
import { createHmac } from 'node:crypto';
import { assert, assertGuard, http, tags } from 'typia';
import { authenticator } from '../../authenticator.js';
import { pool } from '../../database.js';
import { getEnv } from '../../env.js';
import { acceptValidator } from '../../requestValidators.js';
import { ratingSubquery } from './ratingConstants.js';
import { PictureRow } from './types.js';

const secret = getEnv('PREMIUM_PHOTO_SECRET', '');

type CommonQuery = {
  userId?: number & tags.Type<'uint32'> & tags.Minimum<1>;
  ratingFrom?: number & tags.Minimum<0> & tags.Maximum<5>;
  ratingTo?: number & tags.Minimum<0> & tags.Maximum<5>;
  takenAtFrom?: string & tags.Format<'date-time'>;
  takenAtTo?: string & tags.Format<'date-time'>;
  createdAtFrom?: string & tags.Format<'date-time'>;
  createdAtTo?: string & tags.Format<'date-time'>;
  tag?: string;
  pano?: boolean;
  premium?: boolean;
};

type RadiusQuery = CommonQuery & {
  lat: number & tags.Minimum<-90> & tags.Maximum<90>;
  lon: number & tags.Minimum<-180> & tags.Maximum<180>;
  distance: number & tags.Minimum<0>;
};

type BBoxQuery = CommonQuery & {
  bbox: `${number & tags.Minimum<-180> & tags.Maximum<180>},${number & tags.Minimum<-90> & tags.Maximum<90>},${number & tags.Minimum<-180> & tags.Maximum<180>},${number & tags.Minimum<-90> & tags.Maximum<90>}`;
  fields?: Array<
    | 'id'
    | 'title'
    | 'description'
    | 'takenAt'
    | 'createdAt'
    | 'rating'
    | 'userId'
    | 'user'
    | 'tags'
    | 'pano'
    | 'premium'
    | 'azimuth'
    | 'hmac'
  >;
};

type OrderByQuery = CommonQuery & {
  orderBy: 'createdAt' | 'takenAt' | 'rating' | 'lastCommentedAt';
  direction: 'desc' | 'asc';
};

const methods: {
  [name: string]: (ctx: ParameterizedContext) => Promise<void>;
} = {
  radius: byRadius,
  bbox: byBbox,
  order: byOrder,
};

export function attachGetPicturesHandler(router: RouterInstance) {
  router.get(
    '/pictures',
    acceptValidator('application/json'),
    authenticator(false),
    async (ctx) => {
      const method = methods[ctx.query.by as string];

      if (!method) {
        ctx.throw(400, 'by must be one of ' + Object.keys(methods).join(', '));
      }

      await method(ctx);
    },
  );
}

async function byRadius(ctx: ParameterizedContext) {
  let radiusQuery;

  try {
    radiusQuery = http.assertQuery<RadiusQuery>('?' + ctx.querystring);
  } catch (err) {
    ctx.throw(400, err as Error);
  }

  const {
    userId,
    tag,
    ratingFrom,
    ratingTo,
    takenAtFrom,
    takenAtTo,
    createdAtFrom,
    createdAtTo,
    pano,
    premium,
    lat,
    lon,
    distance,
  } = radiusQuery;

  const myUserId = ctx.state.user?.id ?? -1;

  // cca 1 degree
  const lat1 = lat - distance / 43;
  const lat2 = lat + distance / 43;
  const lon1 = lon - distance / Math.abs(Math.cos((lat * Math.PI) / 180) * 43);
  const lon2 = lon + distance / Math.abs(Math.cos((lat * Math.PI) / 180) * 43);

  const sql = `SELECT id,
    (6371 * acos(cos(radians(${lat})) * cos(radians(lat)) * cos(radians(lon) - radians(${lon}) ) + sin(radians(${lat})) * sin(radians(lat)))) AS distance
    ${ratingFrom || ratingTo ? `, ${ratingSubquery}` : ''}
    FROM picture
    ${
      tag
        ? `JOIN pictureTag ON pictureId = picture.id AND pictureTag.name = ${pool.escape(
            tag,
          )}`
        : ''
    }
    WHERE lat BETWEEN ${lat1} AND ${lat2} AND lon BETWEEN ${lon1} AND ${lon2}
    ${takenAtFrom ? `AND takenAt >= '${toSqlDate(takenAtFrom)}'` : ''}
    ${takenAtTo ? `AND takenAt <= '${toSqlDate(takenAtTo)}'` : ''}
    ${createdAtFrom ? `AND createdAt >= '${toSqlDate(createdAtFrom)}'` : ''}
    ${createdAtTo ? `AND createdAt <= '${toSqlDate(createdAtTo)}'` : ''}
    ${pano == null ? '' : ` AND pano = ${pano ? 1 : 0}`}
    ${premium == null ? '' : ` AND premium = ${premium ? 1 : 0}`}
    ${userId ? `AND userId = ${userId}` : ''}
    ${
      ctx.state.user?.isAdmin
        ? ''
        : `AND (id NOT IN (SELECT pictureId FROM pictureTag WHERE name = 'private') OR userId = ${myUserId})`
    }
    ${tag === '' ? 'AND id NOT IN (SELECT pictureId FROM pictureTag)' : ''}
    HAVING distance <= ${distance}
    ${ratingFrom == null ? '' : `AND rating >= ${ratingFrom}`}
    ${ratingTo == null ? '' : `AND rating <= ${ratingTo}`}
    ORDER BY distance
    LIMIT 1000`;

  const rows = assert<{ id: number }[]>(await pool.query(sql));

  ctx.body = rows.map((row) => ({ id: row.id }));
}

function toSqlDate(d: string) {
  return d.replace('T', ' ').replace(/(\.\d*)?Z$/, '');
}

async function byBbox(ctx: ParameterizedContext) {
  let bboxQuery;

  try {
    bboxQuery = http.assertQuery<BBoxQuery>('?' + ctx.querystring);
  } catch (err) {
    ctx.throw(400, err as Error);
  }

  const {
    bbox,
    userId,
    tag,
    ratingFrom,
    ratingTo,
    takenAtFrom,
    takenAtTo,
    createdAtFrom,
    createdAtTo,
    pano,
    premium,
    fields,
  } = bboxQuery;

  const [minLon, minLat, maxLon, maxLat] = bbox
    .split(',')
    .map((a) => Number(a));

  const myUserId = ctx.state.user?.id ?? -1;

  const normFields = fields ?? [];

  const flds = [
    'lat',
    'lon',
    ...normFields.filter(
      (f) => f !== 'rating' && f !== 'tags' && f !== 'user' && f !== 'hmac',
    ),
  ];

  if (flds.includes('hmac') && !flds.includes('premium')) {
    flds.push('premium');
  }

  if (ratingFrom || ratingTo || normFields.includes('rating')) {
    flds.push(ratingSubquery);
  }

  if (normFields.includes('tags')) {
    flds.push(
      "(SELECT GROUP_CONCAT(name SEPARATOR '\n') FROM pictureTag WHERE pictureId = picture.id) AS tags",
    );
  }

  if (normFields.includes('user')) {
    flds.push('(SELECT name FROM user WHERE picture.userId = user.id) AS user');
  }

  const sql = `SELECT ${flds.join(',')}
    FROM picture
    ${
      tag
        ? `JOIN pictureTag ON pictureTag.pictureId = picture.id AND name = ${pool.escape(
            tag,
          )}`
        : ''
    }
    WHERE lat BETWEEN ${minLat} AND ${maxLat} AND lon BETWEEN ${minLon} AND ${maxLon}
    ${takenAtFrom ? `AND takenAt >= '${toSqlDate(takenAtFrom)}'` : ''}
    ${takenAtTo ? `AND takenAt <= '${toSqlDate(takenAtTo)}'` : ''}
    ${createdAtFrom ? `AND createdAt >= '${toSqlDate(createdAtFrom)}'` : ''}
    ${createdAtTo ? `AND createdAt <= '${toSqlDate(createdAtTo)}'` : ''}
    ${pano == null ? '' : `AND pano = ${pano ? 1 : 0}`}
    ${premium == null ? '' : `AND premium = ${premium ? 1 : 0}`}
    ${userId ? `AND userId = ${userId}` : ''}
    ${
      ctx.state.user?.isAdmin
        ? ''
        : `AND (id NOT IN (SELECT pictureId FROM pictureTag WHERE name = 'private') OR userId = ${myUserId})`
    }
    ${tag === '' ? 'AND id NOT IN (SELECT pictureId FROM pictureTag)' : ''}
    ${ratingFrom == null ? '' : `HAVING rating >= ${ratingFrom}`}
    ${
      ratingTo == null
        ? ''
        : `${ratingTo ? 'AND' : 'HAVING'} rating <= ${ratingTo}`
    }
  `;

  const rows = await pool.query(sql);

  const getRating = fields?.includes('rating');

  const getHmac = fields?.includes('hmac');

  assertGuard<
    Partial<
      PictureRow & {
        rating: number | null;
        tags: string | null;
      }
    >[]
  >(rows);

  ctx.body = rows.map((row) =>
    Object.assign({}, row, {
      rating: getRating ? row.rating : undefined,
      takenAt: toSec(row.takenAt),
      createdAt: toSec(row.createdAt),
      pano: row.pano ? 1 : undefined,
      premium: row.premium ? 1 : undefined,
      azimuth: row.azimuth ?? undefined,
      tags: normFields.includes('tags')
        ? (row.tags?.split('\n') ?? [])
        : undefined,
      hmac:
        getHmac && row.premium && secret
          ? createHmac('sha256', secret).update(String(row.id)).digest('hex')
          : undefined,
    }),
  );
}

function toSec(d: Date | null | undefined) {
  return d == null ? d : Math.round(d.getTime() / 1000);
}

async function byOrder(ctx: ParameterizedContext) {
  let orderByQuery;

  try {
    orderByQuery = http.assertQuery<OrderByQuery>('?' + ctx.querystring);
  } catch (err) {
    ctx.throw(400, err as Error);
  }

  const {
    userId,
    tag,
    ratingFrom,
    ratingTo,
    takenAtFrom,
    takenAtTo,
    createdAtFrom,
    createdAtTo,
    orderBy,
    direction,
    pano,
    premium,
  } = orderByQuery;

  const myUserId = ctx.state.user?.id ?? -1;

  const hv = [];

  const wh = ctx.state.user?.isAdmin
    ? []
    : [
        `(id NOT IN (SELECT pictureId FROM pictureTag WHERE name = 'private') OR userId = ${myUserId})`,
      ];

  if (ratingFrom !== undefined) {
    hv.push(`rating >= ${ratingFrom}`);
  }

  if (ratingTo !== undefined) {
    hv.push(`rating <= ${ratingTo}`);
  }

  if (takenAtFrom) {
    wh.push(`takenAt >= '${toSqlDate(takenAtFrom)}'`);
  }

  if (takenAtTo) {
    wh.push(`takenAt <= '${toSqlDate(takenAtTo)}'`);
  }

  if (createdAtFrom) {
    wh.push(`createdAt >= '${toSqlDate(createdAtFrom)}'`);
  }

  if (createdAtTo) {
    wh.push(`createdAt <= '${toSqlDate(createdAtTo)}'`);
  }

  if (pano !== undefined) {
    wh.push(`pano = ${pano ? 1 : 0}`);
  }

  if (premium !== undefined) {
    wh.push(`premium = ${premium ? 1 : 0}`);
  }

  if (userId !== undefined) {
    wh.push(`userId = ${userId}`);
  }

  if (tag === '') {
    wh.push('id NOT IN (SELECT pictureId FROM pictureTag)');
  }

  const sql = `SELECT id ${
    ratingFrom || ratingTo || orderBy === 'rating' ? `, ${ratingSubquery}` : ''
  }
    FROM picture
    ${
      tag
        ? `JOIN pictureTag ON pictureTag.pictureId = picture.id AND name = ${pool.escape(
            tag,
          )}`
        : ''
    }
    ${wh.length ? `WHERE ${wh.join(' AND ')}` : ''}
    ${hv.length ? `HAVING ${hv.join(' AND ')}` : ''}
    ORDER BY ${
      orderBy === 'lastCommentedAt'
        ? `(SELECT MAX(createdAt) FROM pictureComment WHERE pictureId = picture.id)`
        : orderBy
    } ${direction}, id ${direction}
    LIMIT 1000
  `;

  const rows = assert<{ id: number }[]>(await pool.query(sql));

  ctx.body = rows.map((row) => ({ id: row.id }));
}
