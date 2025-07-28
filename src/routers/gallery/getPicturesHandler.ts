import Router from '@koa/router';
import { Middleware, ParameterizedContext } from 'koa';
import { createHmac } from 'node:crypto';
import { authenticator } from '../../authenticator.js';
import { pool } from '../../database.js';
import { getEnv } from '../../env.js';
import {
  ValidationRules,
  acceptValidator,
  queryAdapter,
  queryValidator,
} from '../../requestValidators.js';
import { ratingSubquery } from './ratingConstants.js';

const secret = getEnv('PREMIUM_PHOTO_SECRET', '');

const globalValidationRules: ValidationRules = {
  userId: (v) => v === null || !Number.isNaN(v) || 'invalid userId',
  ratingFrom: (v) => v === null || !Number.isNaN(v) || 'invalid ratingFrom',
  ratingTo: (v) => v === null || !Number.isNaN(v) || 'invalid ratingTo',
  takenAtFrom: (v) => v === null || !Number.isNaN(v) || 'invalid takenAtFrom',
  takenAtTo: (v) => v === null || !Number.isNaN(v) || 'invalid takenAtTo',
  createdAtFrom: (v) =>
    v === null || !Number.isNaN(v) || 'invalid createdAtFrom',
  createdAtTo: (v) => v === null || !Number.isNaN(v) || 'invalid createdAtTo',
};

const radiusQueryValidationRules: ValidationRules = {
  lat: (v) => (v >= -90 && v <= 90) || 'lat must be between -90 and 90',
  lon: (v) => (v >= -180 && v <= 180) || 'lon must be between -180 and 180',
  distance: (v) => v > 0 || 'distance must be positive',
};

const radiusQueryValidator = queryValidator({
  ...radiusQueryValidationRules,
  ...globalValidationRules,
});

const bboxQueryValidationRules: ValidationRules = {
  bbox: (v) =>
    (v && v.length === 4 && v.every((x: any) => !Number.isNaN(x))) ||
    'invalid bbox',
  fields: (v) =>
    !v ||
    (Array.isArray(v) ? v : [v]).every((f: any) =>
      [
        'id',
        'title',
        'description',
        'takenAt',
        'createdAt',
        'rating',
        'userId',
        'user',
        'tags',
        'pano',
        'premium',
        'azimuth',
        'hmac',
      ].includes(f),
    ) ||
    'invalid fields',
};

const bboxQueryValidator = queryValidator({
  ...globalValidationRules,
  ...bboxQueryValidationRules,
});

const orderQueryValidationRules: ValidationRules = {
  orderBy: (v) =>
    ['createdAt', 'takenAt', 'rating', 'lastCommentedAt'].includes(v) ||
    'invalid orderBy',
  direction: (v) => ['desc', 'asc'].includes(v) || 'invalid direction',
};

const orderQueryValidator = queryValidator({
  ...orderQueryValidationRules,
  ...globalValidationRules,
});

const qvs: { [name: string]: Middleware } = {
  radius: radiusQueryValidator,
  bbox: bboxQueryValidator,
  order: orderQueryValidator,
};

const methods: {
  [name: string]: (ctx: ParameterizedContext) => Promise<void>;
} = {
  radius: byRadius,
  bbox: byBbox,
  order: byOrder,
};

export function attachGetPicturesHandler(router: Router) {
  router.get(
    '/pictures',
    acceptValidator('application/json'),
    authenticator(false),
    queryAdapter(
      {
        lat: (x) => (x === undefined ? null : parseFloat(x)),
        lon: (x) => (x === undefined ? null : parseFloat(x)),
        distance: (x) => (x === undefined ? null : parseFloat(x)),

        bbox: (x) => (x === undefined ? null : x.split(',').map(parseFloat)),
        userId: (x) => (x ? parseInt(x, 10) : null),

        ratingFrom: (x) => (x ? parseFloat(x) : null),
        ratingTo: (x) => (x ? parseFloat(x) : null),
        takenAtFrom: (x) => (x ? new Date(x) : null),
        takenAtTo: (x) => (x ? new Date(x) : null),
        createdAtFrom: (x) => (x ? new Date(x) : null),
        createdAtTo: (x) => (x ? new Date(x) : null),
        pano: (x) => (x ? x === 'true' : null),
        premium: (x) => (x ? x === 'true' : null),
      },
      {
        fields: (x) => x,
      },
    ),
    queryValidator({
      by: (v) =>
        ['radius', 'bbox', 'order'].includes(v) ||
        '"by" must be one of "radius", "bbox", "order"',
      userId: (userId) => !userId || userId > 0 || 'invalid userId',
    }),
    async (ctx, next) => {
      await qvs[ctx.query.by as string](ctx, next);
    },
    async (ctx) => {
      await methods[ctx.query.by as string](ctx);
    },
  );
}

async function byRadius(ctx: ParameterizedContext) {
  const myUserId = ctx.state.user?.id ?? -1;

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
  } = ctx.query;

  const lat = Number(ctx.query.lat);
  const lon = Number(ctx.query.lon);
  const distance = Number(ctx.query.distance);

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

  const rows = await pool.query(sql);

  ctx.body = rows.map((row: any) => ({ id: row.id }));
}

function toSqlDate(d: any) {
  return Number.isNaN(d)
    ? d
    : d
        .toISOString()
        .replace('T', ' ')
        .replace(/(\.\d*)?Z$/, '');
}

async function byBbox(ctx: ParameterizedContext) {
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
  } = ctx.query;

  const [minLon, minLat, maxLon, maxLat] = bbox as string[];

  const myUserId = ctx.state.user?.id ?? -1;

  const normFields = !fields ? [] : Array.isArray(fields) ? fields : [fields];

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

  ctx.body = rows.map((row: any) =>
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
  } = ctx.query;

  const myUserId = ctx.state.user?.id ?? -1;

  const hv = [];

  const wh = ctx.state.user?.isAdmin
    ? []
    : [
        `(id NOT IN (SELECT pictureId FROM pictureTag WHERE name = 'private') OR userId = ${myUserId})`,
      ];

  if (ratingFrom !== null) {
    hv.push(`rating >= ${ratingFrom}`);
  }

  if (ratingTo !== null) {
    hv.push(`rating <= ${ratingTo}`);
  }

  if (takenAtFrom !== null) {
    wh.push(`takenAt >= '${toSqlDate(takenAtFrom)}'`);
  }

  if (takenAtTo !== null) {
    wh.push(`takenAt <= '${toSqlDate(takenAtTo)}'`);
  }

  if (createdAtFrom !== null) {
    wh.push(`createdAt >= '${toSqlDate(createdAtFrom)}'`);
  }

  if (createdAtTo !== null) {
    wh.push(`createdAt <= '${toSqlDate(createdAtTo)}'`);
  }

  if (pano !== null) {
    wh.push(`pano = ${pano ? 1 : 0}`);
  }

  if (premium !== null) {
    wh.push(`premium = ${premium ? 1 : 0}`);
  }

  if (userId !== null) {
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

  const rows = await pool.query(sql);

  ctx.body = rows.map((row: any) => ({ id: row.id }));
}
