import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { brotliCompress, gzip, constants as zlibConstants } from 'node:zlib';
import { RouterInstance } from '@koa/router';
import { ParameterizedContext } from 'koa';
import protobuf from 'protobufjs';
import sql, { empty, join, raw, Sql } from 'sql-template-tag';
import z from 'zod';
import { createSchema } from 'zod-openapi';
import { authenticator } from '../../authenticator.js';
import { pool } from '../../database.js';
import { getEnv } from '../../env.js';
import { AUTH_OPTIONAL, registerPath } from '../../openapi.js';
import { acceptValidator } from '../../requestValidators.js';
import { ratingSubquery } from './ratingConstants.js';

const secret = getEnv('PREMIUM_PHOTO_SECRET', '');
const gzipAsync = promisify(gzip);
const brotliCompressAsync = promisify(brotliCompress);

const picturesResponseType = protobuf
  .parse(readFileSync(new URL('./pictures.proto', import.meta.url), 'utf8'))
  .root.lookupType('PicturesResponse');

const booleanParam = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true')
  .pipe(z.boolean())
  .optional();

const CommonQuerySchema = z.object({
  userId: z.coerce.number().int().positive().optional(),
  ratingFrom: z.coerce.number().min(0).max(5).optional(),
  ratingTo: z.coerce.number().min(0).max(5).optional(),
  takenAtFrom: z.iso.datetime().optional(),
  takenAtTo: z.iso.datetime().optional(),
  createdAtFrom: z.iso.datetime().optional(),
  createdAtTo: z.iso.datetime().optional(),
  tag: z.string().nonempty().optional(),
  pano: booleanParam,
  premium: booleanParam,
});

const RadiusQuerySchema = CommonQuerySchema.extend({
  by: z.literal('radius'),
  lat: z.coerce.number().min(-90).max(90),
  lon: z.coerce.number().min(-180).max(180),
  distance: z.coerce.number().min(0),
}).meta({ title: 'radius' });

const fieldValues = [
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
] as const;

const BBoxQuerySchema = CommonQuerySchema.extend({
  by: z.literal('bbox'),
  bbox: z
    .string()
    .transform((s) => s.split(',').map(Number))
    .pipe(z.number().array()),
  fields: z.preprocess(
    (v) => (Array.isArray(v) ? v : v ? [v] : undefined),
    z.array(z.enum(fieldValues)).optional(),
  ),
}).meta({ title: 'bbox' });

const OrderByQuerySchema = CommonQuerySchema.extend({
  by: z.literal('order'),
  orderBy: z.enum(['createdAt', 'takenAt', 'rating', 'lastCommentedAt']),
  direction: z.enum(['desc', 'asc']),
}).meta({ title: 'order' });

const IdRowSchema = z.array(z.object({ id: z.number() }));

const BboxRowSchema = z.array(
  z.object({
    lat: z.number(),
    lon: z.number(),
    id: z.uint32().optional(),
    title: z.string().nullish(),
    description: z.string().nullish(),
    takenAt: z.date().nullish(),
    createdAt: z.date().nullish(),
    userId: z.uint32().nullish(),
    pano: z.boolean().nullish(),
    premium: z.boolean().nullish(),
    azimuth: z.number().nullish(),
    rating: z.number().nullish(),
    tags: z
      .string()
      .nullish()
      .transform((t) =>
        t === undefined ? t : t === null ? [] : t.split('\n'),
      ),
    user: z.string().nullish(),
  }),
);

const methods: {
  [name: string]: (ctx: ParameterizedContext) => Promise<void>;
} = {
  radius: byRadius,
  bbox: byBbox,
  order: byOrder,
};

export function attachGetPicturesHandler(router: RouterInstance) {
  registerPath('/gallery/pictures', {
    get: {
      summary: 'List gallery pictures with filtering',
      tags: ['gallery'],
      security: AUTH_OPTIONAL,
      parameters: [
        {
          in: 'query',
          name: 'q',
          style: 'form',
          explode: true,
          required: true,
          schema: {
            discriminator: { propertyName: 'by' },
            ...createSchema(
              z.discriminatedUnion('by', [
                RadiusQuerySchema,
                BBoxQuerySchema,
                OrderByQuerySchema,
              ]),
            ).schema,
          },
        },
      ],
      responses: {
        200: {
          content: {
            'application/json': {},
            'application/x-protobuf': {},
          },
        },
      },
    },
  });

  router.get(
    '/pictures',
    acceptValidator('application/json', 'application/x-protobuf'),
    authenticator(false),
    async (ctx) => {
      const method = methods[ctx.query.by as string];

      if (!method) {
        ctx.throw(400, 'by must be one of ' + Object.keys(methods).join(', '));
      }

      const acceptedType = ctx.accepts(
        'application/json',
        'application/x-protobuf',
      );

      if (acceptedType === 'application/x-protobuf' && method !== byBbox) {
        ctx.throw(406, 'protobuf response is supported only for by=bbox');
      }

      await method(ctx);
    },
  );
}

async function byRadius(ctx: ParameterizedContext) {
  let radiusQuery;

  try {
    radiusQuery = RadiusQuerySchema.parse(ctx.query);
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
  const minLat = lat - distance / 43;
  const maxLat = lat + distance / 43;
  const k = distance / Math.abs(Math.cos((lat * Math.PI) / 180) * 43);
  const minLon = lon - k;
  const maxLon = lon + k;

  const query = sql`SELECT id,
    ST_Distance_Sphere(location, POINT(${lon}, ${lat})) / 1000 AS distance
    ${ratingFrom !== undefined || ratingTo !== undefined ? sql`, ${raw(ratingSubquery)}` : empty}
    FROM picture
    ${
      tag
        ? sql`JOIN pictureTag ON pictureId = picture.id AND pictureTag.name = ${tag}`
        : empty
    }
    WHERE MBRContains(ST_GeomFromText(${`LINESTRING(${minLon} ${minLat}, ${maxLon} ${maxLat})`}, 4326), location)
    ${takenAtFrom ? sql`AND takenAt >= ${new Date(takenAtFrom)}` : empty}
    ${takenAtTo ? sql`AND takenAt <= ${new Date(takenAtTo)}` : empty}
    ${createdAtFrom ? sql`AND createdAt >= ${new Date(createdAtFrom)}` : empty}
    ${createdAtTo ? sql`AND createdAt <= ${new Date(createdAtTo)}` : empty}
    ${pano == null ? empty : sql`AND pano = ${pano}`}
    ${premium == null ? empty : sql`AND premium = ${premium}`}
    ${userId ? sql`AND userId = ${userId}` : empty}
    ${
      ctx.state.user?.isAdmin
        ? empty
        : sql`AND (id NOT IN (SELECT pictureId FROM pictureTag WHERE name = 'private') OR userId = ${myUserId})`
    }
    ${tag === '' ? raw('AND id NOT IN (SELECT pictureId FROM pictureTag)') : empty}
    HAVING distance <= ${distance}
    ${ratingFrom == null ? empty : sql`AND rating >= ${ratingFrom}`}
    ${ratingTo == null ? empty : sql`AND rating <= ${ratingTo}`}
    ORDER BY distance
    LIMIT 1000`;

  const rows = IdRowSchema.parse(await pool.query(query));

  ctx.body = rows.map((row) => ({ id: row.id }));
}

async function byBbox(ctx: ParameterizedContext) {
  let bboxQuery;

  try {
    bboxQuery = BBoxQuerySchema.parse(ctx.query);
  } catch (err) {
    ctx.throw(400, err as Error);
  }

  const {
    bbox: [minLon, minLat, maxLon, maxLat],
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

  const myUserId = ctx.state.user?.id ?? -1;

  const sqlFields: string[] = (fields ?? []).filter(
    (f) => f !== 'rating' && f !== 'tags' && f !== 'user' && f !== 'hmac',
  );

  sqlFields.push('ST_X(location) AS lon', 'ST_Y(location) AS lat');

  if (fields?.includes('hmac') && !sqlFields.includes('premium')) {
    sqlFields.push('premium');
  }

  if (ratingFrom || ratingTo || fields?.includes('rating')) {
    sqlFields.push(ratingSubquery);
  }

  if (fields?.includes('tags')) {
    sqlFields.push(
      "(SELECT GROUP_CONCAT(name SEPARATOR '\n') FROM pictureTag WHERE pictureId = picture.id) AS tags",
    );
  }

  if (fields?.includes('user')) {
    sqlFields.push(
      '(SELECT name FROM user WHERE picture.userId = user.id) AS user',
    );
  }

  const query = sql`SELECT ${raw(sqlFields.join(','))}
    FROM picture
    ${
      tag
        ? sql`JOIN pictureTag ON pictureTag.pictureId = picture.id AND name = ${tag}`
        : empty
    }
    WHERE MBRContains(ST_GeomFromText(${`LINESTRING(${minLon} ${minLat}, ${maxLon} ${maxLat})`}, 4326), location)
    ${takenAtFrom ? sql`AND takenAt >= ${new Date(takenAtFrom)}` : empty}
    ${takenAtTo ? sql`AND takenAt <= ${new Date(takenAtTo)}` : empty}
    ${createdAtFrom ? sql`AND createdAt >= ${new Date(createdAtFrom)}` : empty}
    ${createdAtTo ? sql`AND createdAt <= ${new Date(createdAtTo)}` : empty}
    ${pano == null ? empty : sql`AND pano = ${pano}`}
    ${premium == null ? empty : sql`AND premium = ${premium}`}
    ${userId ? sql`AND userId = ${userId}` : empty}
    ${
      ctx.state.user?.isAdmin
        ? empty
        : sql`AND (id NOT IN (SELECT pictureId FROM pictureTag WHERE name = 'private') OR userId = ${myUserId})`
    }
    ${tag === '' ? raw('AND id NOT IN (SELECT pictureId FROM pictureTag)') : empty}
    ${ratingFrom == null ? empty : sql`HAVING rating >= ${ratingFrom}`}
    ${
      ratingTo == null
        ? empty
        : `${raw(ratingTo ? 'AND' : 'HAVING')} rating <= ${ratingTo}`
    }
    ORDER BY lat, lon
  `;

  const rows = BboxRowSchema.parse(await pool.query(query));

  const getRating = fields?.includes('rating');

  const getHmac = fields?.includes('hmac');

  const isProtobuf =
    ctx.accepts('application/json', 'application/x-protobuf') ===
    'application/x-protobuf';

  const pictures = rows.map((row) =>
    Object.assign({}, row, {
      rating: getRating ? row.rating : undefined,
      takenAt: isProtobuf
        ? row.takenAt == null
          ? row.takenAt
          : row.takenAt.getTime() / 1000
        : (row.takenAt?.toISOString() ?? row.takenAt),
      createdAt: isProtobuf
        ? row.createdAt == null
          ? row.createdAt
          : row.createdAt.getTime() / 1000
        : (row.createdAt?.toISOString() ?? row.createdAt),
      pano: row.pano,
      premium: row.premium,
      azimuth: row.azimuth,
      tags: row.tags,
      hmac:
        getHmac && row.premium && secret
          ? createHmac('sha256', secret).update(String(row.id)).digest('hex')
          : undefined,
    }),
  );

  if (!isProtobuf) {
    ctx.body = pictures;

    return;
  }

  let prevLon: number | undefined;
  let prevLat: number | undefined;

  for (const picture of pictures) {
    const lon = Math.round(picture.lon * 1e6);
    picture.lon = prevLon === undefined ? lon : lon - prevLon;
    prevLon = lon;

    const lat = Math.round(picture.lat * 1e6);
    picture.lat = prevLat === undefined ? lat : lat - prevLat;
    prevLat = lat;
  }

  const body = { pictures };

  const err = picturesResponseType.verify(body);

  if (err) {
    ctx.throw(500, err);
  }

  let payload = Buffer.from(picturesResponseType.encode(body).finish());

  const encoding = ctx.acceptsEncodings('br', 'gzip', 'identity');

  ctx.vary('Accept-Encoding');

  if (payload.length >= 1024 && encoding && encoding !== 'identity') {
    if (encoding === 'br') {
      payload = await brotliCompressAsync(payload, {
        params: {
          [zlibConstants.BROTLI_PARAM_QUALITY]: 4,
        },
      });

      ctx.set('Content-Encoding', 'br');
    } else if (encoding === 'gzip') {
      payload = await gzipAsync(payload);

      ctx.set('Content-Encoding', 'gzip');
    }
  }

  ctx.type = 'application/x-protobuf';
  ctx.body = payload;
}

async function byOrder(ctx: ParameterizedContext) {
  let orderByQuery;

  try {
    orderByQuery = OrderByQuerySchema.parse(ctx.query);
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

  const hv: Sql[] = [];

  const wh = ctx.state.user?.isAdmin
    ? []
    : [
        sql`(id NOT IN (SELECT pictureId FROM pictureTag WHERE name = 'private') OR userId = ${myUserId})`,
      ];

  if (ratingFrom !== undefined) {
    hv.push(sql`rating >= ${ratingFrom}`);
  }

  if (ratingTo !== undefined) {
    hv.push(sql`rating <= ${ratingTo}`);
  }

  if (takenAtFrom) {
    wh.push(sql`takenAt >= ${new Date(takenAtFrom)}`);
  }

  if (takenAtTo) {
    wh.push(sql`takenAt <= ${new Date(takenAtTo)}`);
  }

  if (createdAtFrom) {
    wh.push(sql`createdAt >= ${new Date(createdAtFrom)}`);
  }

  if (createdAtTo) {
    wh.push(sql`createdAt <= ${new Date(createdAtTo)}`);
  }

  if (pano !== undefined) {
    wh.push(sql`pano = ${pano ? 1 : 0}`);
  }

  if (premium !== undefined) {
    wh.push(sql`premium = ${premium ? 1 : 0}`);
  }

  if (userId !== undefined) {
    wh.push(sql`userId = ${userId}`);
  }

  if (tag === '') {
    wh.push(sql`id NOT IN (SELECT pictureId FROM pictureTag)`);
  }

  const query = sql`SELECT id ${
    ratingFrom !== undefined || ratingTo !== undefined || orderBy === 'rating'
      ? raw(', ' + ratingSubquery)
      : empty
  }
    FROM picture
    ${
      tag
        ? sql`JOIN pictureTag ON pictureTag.pictureId = picture.id AND name = ${tag}`
        : empty
    }
    ${wh.length ? sql`WHERE ${join(wh, ' AND ')}` : empty}
    ${hv.length ? sql`HAVING ${join(hv, ' AND ')}` : empty}
    ORDER BY ${
      orderBy === 'lastCommentedAt'
        ? sql`(SELECT MAX(createdAt) FROM pictureComment WHERE pictureId = picture.id)`
        : raw(orderBy)
    } ${raw(direction)}, id ${raw(direction)}
    LIMIT 1000
  `;

  const rows = IdRowSchema.parse(await pool.query(query));

  ctx.body = rows.map((row) => ({ id: row.id }));
}
