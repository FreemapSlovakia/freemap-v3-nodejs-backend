import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { brotliCompress, gzip, constants as zlibConstants } from 'node:zlib';
import type { RouterInstance } from '@koa/router';
import type { ParameterizedContext } from 'koa';
import protobuf from 'protobufjs';
import sql, { empty, join, raw, type Sql } from 'sql-template-tag';
import z from 'zod';
import { createSchema, type oas31 } from 'zod-openapi';
import { authenticator } from '../../authenticator.js';
import { pool } from '../../database.js';
import { getEnv } from '../../env.js';
import { AUTH_OPTIONAL, registerPath } from '../../openapi.js';
import { acceptValidator } from '../../requestValidators.js';
import { hasRole } from '../../roles.js';
import { LicenseSchema } from './licenses.js';
import {
  ratingExp,
  ratingSubquery,
  wikimediaRatingSubquery,
} from './ratingConstants.js';

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
  userId: z.preprocess(
    (v) => (Array.isArray(v) ? v : v ? [v] : undefined),
    z.array(z.coerce.number().int().positive()).optional(),
  ),
  ratingFrom: z.coerce.number().min(0).max(5).optional(),
  ratingTo: z.coerce.number().min(0).max(5).optional(),
  takenAtFrom: z.iso.datetime().optional(),
  takenAtTo: z.iso.datetime().optional(),
  createdAtFrom: z.iso.datetime().optional(),
  createdAtTo: z.iso.datetime().optional(),
  tag: z.preprocess(
    (v) => (Array.isArray(v) ? v : v ? [v] : undefined),
    z.array(z.string().nonempty()).optional(),
  ),
  tagMode: z.enum(['any', 'all']).default('any'),
  pano: booleanParam,
  premium: booleanParam,
  license: z.preprocess(
    (v) => (Array.isArray(v) ? v : v ? [v] : undefined),
    z.array(LicenseSchema).optional(),
  ),
  // Which photo sources to include; defaults to both. Any gallery-only filter
  // (userId, tag, rating, date, pano, premium, license) implicitly drops the
  // wikimedia source since those attributes do not exist for it.
  sources: z.preprocess(
    (v) => (Array.isArray(v) ? v : v ? [v] : undefined),
    z.array(z.enum(['gallery', 'wikimedia'])).optional(),
  ),
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
  'license',
  'lastCommentedAt',
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

// Safety cap for the wikimedia arm in dense areas; the client also gates it by
// zoom before ever requesting it.
const WIKIMEDIA_BBOX_LIMIT = 5000;

const WikimediaBboxRowSchema = z.array(
  z.object({
    id: z.uint32(),
    lat: z.number(),
    lon: z.number(),
    rating: z.number().nullish(),
    takenAt: z.date().nullish(),
    createdAt: z.date().nullish(),
    azimuth: z.number().nullish(),
    // Numeric Commons actor id; kept as a plain number (actor ids fit well
    // within 2^53) so colorize-by-author can bucket by it like our own userId.
    userId: z.preprocess(
      (v) => (v == null ? v : Number(v)),
      z.number().int().nonnegative().nullish(),
    ),
  }),
);

const OrderByQuerySchema = CommonQuerySchema.extend({
  by: z.literal('order'),
  orderBy: z.enum(['createdAt', 'takenAt', 'rating', 'lastCommentedAt']),
  direction: z.enum(['desc', 'asc']),
}).meta({ title: 'order' });

const IdRowSchema = z.array(z.object({ id: z.number() }));

const RadiusRowSchema = z.array(
  z.object({ id: z.uint32(), distance: z.number() }),
);

const BboxRowSchema = z.array(
  z.object({
    lat: z.number(),
    lon: z.number(),
    id: z.uint32().optional(),
    title: z.string().nullish(),
    description: z.string().nullish(),
    takenAt: z.date().nullish(),
    createdAt: z.date().nullish(),
    lastCommentedAt: z.date().nullish(),
    userId: z.uint32().nullish(),
    pano: z.boolean().nullish(),
    premium: z.boolean().nullish(),
    azimuth: z.number().nullish(),
    license: z.string().nullish(),
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

type WikimediaFilter = {
  takenAtFrom?: string;
  takenAtTo?: string;
  createdAtFrom?: string;
  createdAtTo?: string;
  ratingFrom?: number;
  ratingTo?: number;
};

// Date-range conditions for the Wikimedia arm, against the imported
// `capturedAt` / `uploadedAt` columns. Rows with a NULL date drop out of a
// range automatically, which is what we want (a photo with no such date can't
// match a range on it).
function wikimediaDateConds(f: WikimediaFilter): Sql[] {
  const c: Sql[] = [];

  if (f.takenAtFrom) {
    c.push(sql`capturedAt >= ${new Date(f.takenAtFrom)}`);
  }

  if (f.takenAtTo) {
    c.push(sql`capturedAt <= ${new Date(f.takenAtTo)}`);
  }

  if (f.createdAtFrom) {
    c.push(sql`uploadedAt >= ${new Date(f.createdAtFrom)}`);
  }

  if (f.createdAtTo) {
    c.push(sql`uploadedAt <= ${new Date(f.createdAtTo)}`);
  }

  return c;
}

// Rating-range conditions against the effective Bayesian `rating` alias (which
// callers must SELECT via `wikimediaRatingSubquery`), applied in HAVING.
function ratingRangeConds(ratingFrom?: number, ratingTo?: number): Sql[] {
  const c: Sql[] = [];

  if (ratingFrom != null) {
    c.push(sql`rating >= ${ratingFrom}`);
  }

  if (ratingTo != null) {
    c.push(sql`rating <= ${ratingTo}`);
  }

  return c;
}

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
            ...(createSchema(
              z.discriminatedUnion('by', [
                RadiusQuerySchema,
                BBoxQuerySchema,
                OrderByQuerySchema,
              ]),
            ).schema as oas31.SchemaObject),
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
        ctx.throw(400, `by must be one of ${Object.keys(methods).join(', ')}`);
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
    tagMode,
    ratingFrom,
    ratingTo,
    takenAtFrom,
    takenAtTo,
    createdAtFrom,
    createdAtTo,
    pano,
    premium,
    license,
    sources,
    lat,
    lon,
    distance,
  } = radiusQuery;

  const myUserId = ctx.state.user?.id ?? -1;
  const userIdArray = userId || [];
  const tagArray = tag || [];
  const licenseArray = license || [];

  // Wikimedia photos carry date/rating and are trivially non-pano/non-premium,
  // so those filters narrow them; tag/author/license (and pano=true/premium=true,
  // which no Wikimedia photo matches) have no equivalent and exclude them.
  const wikimediaExcluded =
    tag !== undefined ||
    userIdArray.length > 0 ||
    licenseArray.length > 0 ||
    pano === true ||
    premium === true;

  const includeGallery = !sources || sources.includes('gallery');

  const includeWikimedia =
    (!sources || sources.includes('wikimedia')) && !wikimediaExcluded;

  const wmDateConds = wikimediaDateConds(radiusQuery);

  const wmRatingConds = ratingRangeConds(ratingFrom, ratingTo);

  // cca 1 degree
  const minLat = lat - distance / 43;
  const maxLat = lat + distance / 43;
  const k = distance / Math.abs(Math.cos((lat * Math.PI) / 180) * 43);
  const minLon = lon - k;
  const maxLon = lon + k;

  const query = sql`SELECT picture.id,
    ST_Distance_Sphere(location, POINT(${lon}, ${lat})) / 1000 AS distance
    ${ratingFrom !== undefined || ratingTo !== undefined ? sql`, ${raw(ratingSubquery)}` : empty}
    FROM picture
    ${
      tagArray.length > 0
        ? tagMode === 'all'
          ? sql`JOIN (SELECT pictureId FROM pictureTag WHERE name IN (${join(tagArray)}) GROUP BY pictureId HAVING COUNT(DISTINCT name) = ${tagArray.length}) AS pt ON pt.pictureId = picture.id`
          : sql`JOIN (SELECT DISTINCT pictureId FROM pictureTag WHERE name IN (${join(tagArray)})) AS pt ON pt.pictureId = picture.id`
        : empty
    }
    WHERE MBRContains(ST_GeomFromText(${`LINESTRING(${minLon} ${minLat}, ${maxLon} ${maxLat})`}, 4326), location)
    ${takenAtFrom ? sql`AND takenAt >= ${new Date(takenAtFrom)}` : empty}
    ${takenAtTo ? sql`AND takenAt <= ${new Date(takenAtTo)}` : empty}
    ${createdAtFrom ? sql`AND createdAt >= ${new Date(createdAtFrom)}` : empty}
    ${createdAtTo ? sql`AND createdAt <= ${new Date(createdAtTo)}` : empty}
    ${pano == null ? empty : sql`AND pano = ${pano}`}
    ${premium == null ? empty : sql`AND premium = ${premium}`}
    ${userIdArray.length > 0 ? sql`AND userId IN (${join(userIdArray)})` : empty}
    ${licenseArray.length > 0 ? sql`AND license IN (${join(licenseArray)})` : empty}
    ${
      hasRole(ctx.state.user, 'galleryModerator')
        ? empty
        : sql`AND (picture.id NOT IN (SELECT pictureId FROM pictureTag WHERE name = 'private') OR userId = ${myUserId})`
    }
    ${tagArray.length === 0 && tag !== undefined ? raw('AND picture.id NOT IN (SELECT pictureId FROM pictureTag)') : empty}
    HAVING distance <= ${distance}
    ${ratingFrom == null ? empty : sql`AND rating >= ${ratingFrom}`}
    ${ratingTo == null ? empty : sql`AND rating <= ${ratingTo}`}
    ORDER BY distance
    LIMIT 1000`;

  const galleryRows = includeGallery
    ? RadiusRowSchema.parse(await pool.query<unknown>(query)).map((row) => ({
        id: row.id,
        distance: row.distance,
        source: 0,
      }))
    : [];

  const wikimediaRows = includeWikimedia
    ? RadiusRowSchema.parse(
        await pool.query<unknown>(sql`
          SELECT pageId AS id,
            ST_Distance_Sphere(location, POINT(${lon}, ${lat})) / 1000 AS distance
            ${wmRatingConds.length ? raw(`, ${wikimediaRatingSubquery}`) : empty}
          FROM wikimediaPicture
          WHERE MBRContains(ST_GeomFromText(${`LINESTRING(${minLon} ${minLat}, ${maxLon} ${maxLat})`}, 4326), location)
          ${wmDateConds.length ? sql`AND ${join(wmDateConds, ' AND ')}` : empty}
          HAVING distance <= ${distance}
          ${wmRatingConds.length ? sql`AND ${join(wmRatingConds, ' AND ')}` : empty}
          ORDER BY distance
          LIMIT 1000`),
      ).map((row) => ({ id: row.id, distance: row.distance, source: 1 }))
    : [];

  ctx.body = [...galleryRows, ...wikimediaRows]
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 1000)
    .map((row) => ({ id: row.id, source: row.source }));
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
    tagMode,
    ratingFrom,
    ratingTo,
    takenAtFrom,
    takenAtTo,
    createdAtFrom,
    createdAtTo,
    pano,
    premium,
    license,
    fields,
    sources,
  } = bboxQuery;

  const myUserId = ctx.state.user?.id ?? -1;
  const userIdArray = userId || [];
  const tagArray = tag || [];
  const licenseArray = license || [];

  // Wikimedia photos carry date/rating and are trivially non-pano/non-premium,
  // so those filters narrow them; tag/author/license (and pano=true/premium=true)
  // have no equivalent and exclude them.
  const wikimediaExcluded =
    tag !== undefined ||
    userIdArray.length > 0 ||
    licenseArray.length > 0 ||
    pano === true ||
    premium === true;

  const includeGallery = !sources || sources.includes('gallery');

  const includeWikimedia =
    (!sources || sources.includes('wikimedia')) && !wikimediaExcluded;

  const sqlFields: string[] = (fields ?? []).filter(
    (f) =>
      f !== 'rating' &&
      f !== 'tags' &&
      f !== 'user' &&
      f !== 'hmac' &&
      f !== 'lastCommentedAt',
  );

  sqlFields.push('ST_X(location) AS lon', 'ST_Y(location) AS lat');

  if (fields?.includes('hmac') && !sqlFields.includes('premium')) {
    sqlFields.push('premium');
  }

  if (ratingFrom != null || ratingTo != null || fields?.includes('rating')) {
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

  if (fields?.includes('lastCommentedAt')) {
    sqlFields.push(
      '(SELECT MAX(createdAt) FROM pictureComment WHERE pictureId = picture.id) AS lastCommentedAt',
    );
  }

  const query = sql`SELECT ${raw(sqlFields.join(','))}
    FROM picture
    ${
      tagArray.length > 0
        ? tagMode === 'all'
          ? sql`JOIN (SELECT pictureId FROM pictureTag WHERE name IN (${join(tagArray)}) GROUP BY pictureId HAVING COUNT(DISTINCT name) = ${tagArray.length}) AS pt ON pt.pictureId = picture.id`
          : sql`JOIN (SELECT DISTINCT pictureId FROM pictureTag WHERE name IN (${join(tagArray)})) AS pt ON pt.pictureId = picture.id`
        : empty
    }
    WHERE MBRContains(ST_GeomFromText(${`LINESTRING(${minLon} ${minLat}, ${maxLon} ${maxLat})`}, 4326), location)
    ${takenAtFrom ? sql`AND takenAt >= ${new Date(takenAtFrom)}` : empty}
    ${takenAtTo ? sql`AND takenAt <= ${new Date(takenAtTo)}` : empty}
    ${createdAtFrom ? sql`AND createdAt >= ${new Date(createdAtFrom)}` : empty}
    ${createdAtTo ? sql`AND createdAt <= ${new Date(createdAtTo)}` : empty}
    ${pano == null ? empty : sql`AND pano = ${pano}`}
    ${premium == null ? empty : sql`AND premium = ${premium}`}
    ${userIdArray.length > 0 ? sql`AND userId IN (${join(userIdArray)})` : empty}
    ${licenseArray.length > 0 ? sql`AND license IN (${join(licenseArray)})` : empty}
    ${
      hasRole(ctx.state.user, 'galleryModerator')
        ? empty
        : sql`AND (picture.id NOT IN (SELECT pictureId FROM pictureTag WHERE name = 'private') OR userId = ${myUserId})`
    }
    ${tagArray.length === 0 && tag !== undefined ? raw('AND picture.id NOT IN (SELECT pictureId FROM pictureTag)') : empty}
    ${ratingFrom == null ? empty : sql`HAVING rating >= ${ratingFrom}`}
    ${
      ratingTo == null
        ? empty
        : sql`${raw(ratingFrom == null ? 'HAVING' : 'AND')} rating <= ${ratingTo}`
    }
    ORDER BY lat, lon
  `;

  const rows = includeGallery
    ? BboxRowSchema.parse(await pool.query<unknown>(query))
    : [];

  const getRating = fields?.includes('rating');

  const getHmac = fields?.includes('hmac');

  const isProtobuf =
    ctx.accepts('application/json', 'application/x-protobuf') ===
    'application/x-protobuf';

  const galleryPictures = rows.map((row) =>
    Object.assign({}, row, {
      source: 0,
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
      lastCommentedAt: isProtobuf
        ? row.lastCommentedAt == null
          ? row.lastCommentedAt
          : row.lastCommentedAt.getTime() / 1000
        : (row.lastCommentedAt?.toISOString() ?? row.lastCommentedAt),
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

  // Wikimedia photos carry capturedAt/uploadedAt/authorId (imported from the
  // Commons image dump), surfaced under the same field names as our own photos
  // so the client's date/season/author colorizing works uniformly.
  const wmExtra: string[] = [];

  if (fields?.includes('takenAt')) {
    wmExtra.push('capturedAt AS takenAt');
  }

  if (fields?.includes('createdAt')) {
    wmExtra.push('uploadedAt AS createdAt');
  }

  if (fields?.includes('userId')) {
    wmExtra.push('authorId AS userId');
  }

  if (fields?.includes('azimuth')) {
    wmExtra.push('azimuth');
  }

  const wmDateConds = wikimediaDateConds(bboxQuery);

  const wmRatingConds = ratingRangeConds(ratingFrom, ratingTo);

  // The effective rating is needed for output (getRating) and/or to filter by
  // the rating range.
  if (getRating || wmRatingConds.length) {
    wmExtra.push(wikimediaRatingSubquery);
  }

  const wikimediaRows = includeWikimedia
    ? WikimediaBboxRowSchema.parse(
        await pool.query<unknown>(sql`
          SELECT pageId AS id, ST_X(location) AS lon, ST_Y(location) AS lat
          ${wmExtra.length ? raw(`, ${wmExtra.join(', ')}`) : empty}
          FROM wikimediaPicture
          WHERE MBRContains(ST_GeomFromText(${`LINESTRING(${minLon} ${minLat}, ${maxLon} ${maxLat})`}, 4326), location)
          ${wmDateConds.length ? sql`AND ${join(wmDateConds, ' AND ')}` : empty}
          ${wmRatingConds.length ? sql`HAVING ${join(wmRatingConds, ' AND ')}` : empty}
          LIMIT ${WIKIMEDIA_BBOX_LIMIT}`),
      )
    : [];

  const wikimediaPictures = wikimediaRows.map((row) => ({
    id: row.id,
    lat: row.lat,
    lon: row.lon,
    source: 1,
    title: undefined,
    description: undefined,
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
    lastCommentedAt: undefined,
    userId: row.userId ?? undefined,
    pano: undefined,
    premium: undefined,
    azimuth: row.azimuth ?? undefined,
    license: undefined,
    rating: getRating ? row.rating : undefined,
    tags: undefined,
    user: undefined,
    hmac: undefined,
  }));

  const pictures: (
    | (typeof galleryPictures)[number]
    | (typeof wikimediaPictures)[number]
  )[] = [...galleryPictures, ...wikimediaPictures];

  // Keep the merged stream ordered so protobuf delta-encoding stays compact
  // (the gallery arm is already ORDER BY lat, lon; re-sort once merged).
  if (wikimediaPictures.length > 0) {
    pictures.sort((a, b) => a.lat - b.lat || a.lon - b.lon);
  }

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
    tagMode,
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
    license,
    sources,
  } = orderByQuery;

  const myUserId = ctx.state.user?.id ?? -1;
  const userIdArray = userId || [];
  const tagArray = tag || [];
  const licenseArray = license || [];

  // Wikimedia photos carry a rating/comments (on our platform) and an imported
  // capturedAt/uploadedAt, so they join every ordering and honour the date and
  // rating filters (and, trivially, pano=false / premium=false). tag/author/
  // license (and pano=true / premium=true) have no equivalent and exclude them.
  const wikimediaExcluded =
    tag !== undefined ||
    userIdArray.length > 0 ||
    licenseArray.length > 0 ||
    pano === true ||
    premium === true;

  const includeGallery = !sources || sources.includes('gallery');

  const includeWikimedia =
    (!sources || sources.includes('wikimedia')) && !wikimediaExcluded;

  const hv: Sql[] = [];

  const wh = hasRole(ctx.state.user, 'galleryModerator')
    ? []
    : [
        sql`(picture.id NOT IN (SELECT pictureId FROM pictureTag WHERE name = 'private') OR userId = ${myUserId})`,
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

  if (userIdArray.length > 0) {
    wh.push(sql`userId IN (${join(userIdArray)})`);
  }

  if (licenseArray.length > 0) {
    wh.push(sql`license IN (${join(licenseArray)})`);
  }

  if (tagArray.length === 0 && tag !== undefined) {
    wh.push(sql`picture.id NOT IN (SELECT pictureId FROM pictureTag)`);
  }

  const query = sql`SELECT picture.id ${
    ratingFrom !== undefined || ratingTo !== undefined || orderBy === 'rating'
      ? raw(`, ${ratingSubquery}`)
      : empty
  }
    FROM picture
    ${
      tagArray.length > 0
        ? tagMode === 'all'
          ? sql`JOIN (SELECT pictureId FROM pictureTag WHERE name IN (${join(tagArray)}) GROUP BY pictureId HAVING COUNT(DISTINCT name) = ${tagArray.length}) AS pt ON pt.pictureId = picture.id`
          : sql`JOIN (SELECT DISTINCT pictureId FROM pictureTag WHERE name IN (${join(tagArray)})) AS pt ON pt.pictureId = picture.id`
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

  if (!includeWikimedia) {
    if (!includeGallery) {
      ctx.body = [];

      return;
    }

    const rows = IdRowSchema.parse(await pool.query<unknown>(query));

    ctx.body = rows.map((row) => ({ id: row.id }));

    return;
  }

  // Every ordering also covers the Commons photos, honouring the same date and
  // rating filters as own photos: rating from wikimediaRating, last-comment from
  // wikimediaComment, taken/upload date from wikimediaPicture (skipping rows with
  // no date). Both arms expose the order key as `ord` — and, when a rating range
  // is set, `rating` (so the UNION arms stay column-compatible) — and a UNION
  // lets the DB do the final merge-sort. `wh` already carries the date/pano/
  // premium/private conditions and `hv` the rating range (built above); the
  // Wikimedia arm re-derives the same against its own columns.
  const needRating = hv.length > 0; // hv holds only the rating-range conditions

  const wmDateConds = wikimediaDateConds(orderByQuery);

  const wmDateJoin = wmDateConds.length
    ? sql`JOIN wikimediaPicture wp ON wp.pageId = w.pageId WHERE ${join(wmDateConds, ' AND ')}`
    : empty;

  let wmArm: Sql;

  if (orderBy === 'rating') {
    // ord is the rating aggregate itself, so the rating range is a plain HAVING.
    wmArm = sql`SELECT -CAST(w.pageId AS SIGNED) AS id, ${raw(ratingExp)} AS ord
        ${needRating ? sql`, ${raw(ratingExp)} AS rating` : empty}
        FROM wikimediaRating w ${wmDateJoin}
        GROUP BY w.pageId
        ${needRating ? sql`HAVING ${join(hv, ' AND ')}` : empty}
        ORDER BY ord ${raw(direction)}, id ${raw(direction)} LIMIT 1000`;
  } else if (orderBy === 'lastCommentedAt') {
    wmArm = sql`SELECT -CAST(w.pageId AS SIGNED) AS id, MAX(w.createdAt) AS ord
        ${needRating ? raw(`, (SELECT ${ratingExp} FROM wikimediaRating WHERE pageId = w.pageId) AS rating`) : empty}
        FROM wikimediaComment w ${wmDateJoin}
        GROUP BY w.pageId
        ${needRating ? sql`HAVING ${join(hv, ' AND ')}` : empty}
        ORDER BY ord ${raw(direction)}, id ${raw(direction)} LIMIT 1000`;
  } else {
    // createdAt → uploadedAt, takenAt → capturedAt (from the Commons image
    // dump); an index on each keeps this LIMIT 1000 fast over the whole table.
    const col = orderBy === 'takenAt' ? 'capturedAt' : 'uploadedAt';

    const wmWhere = [sql`${raw(col)} IS NOT NULL`, ...wmDateConds];

    wmArm = sql`SELECT -CAST(pageId AS SIGNED) AS id, ${raw(col)} AS ord
        ${needRating ? raw(`, ${wikimediaRatingSubquery}`) : empty}
        FROM wikimediaPicture
        WHERE ${join(wmWhere, ' AND ')}
        ${needRating ? sql`HAVING ${join(hv, ' AND ')}` : empty}
        ORDER BY ord ${raw(direction)}, id ${raw(direction)} LIMIT 1000`;
  }

  const arms: Sql[] = [];

  if (includeGallery) {
    const ownOrd =
      orderBy === 'rating'
        ? raw(
            `(SELECT ${ratingExp} FROM pictureRating WHERE pictureId = picture.id)`,
          )
        : orderBy === 'lastCommentedAt'
          ? sql`(SELECT MAX(createdAt) FROM pictureComment WHERE pictureId = picture.id)`
          : raw(orderBy);

    // Same filters as the non-UNION query: `wh` (private guard + date/pano/
    // premium) and `hv` (rating range, needing the rating subquery selected).
    arms.push(sql`SELECT picture.id AS id, ${ownOrd} AS ord
      ${needRating ? raw(`, ${ratingSubquery}`) : empty}
      FROM picture
      ${wh.length ? sql`WHERE ${join(wh, ' AND ')}` : empty}
      ${hv.length ? sql`HAVING ${join(hv, ' AND ')}` : empty}
      ORDER BY ord ${raw(direction)}, id ${raw(direction)}
      LIMIT 1000`);
  }

  arms.push(wmArm);

  const rows = IdRowSchema.parse(
    await pool.query<unknown>(sql`
      SELECT id FROM (
        ${join(
          arms.map((arm) => sql`(${arm})`),
          ' UNION ALL ',
        )}
      ) AS t
      ORDER BY ord ${raw(direction)}, id ${raw(direction)}
      LIMIT 1000`),
  );

  ctx.body = rows.map((row) => ({ id: row.id }));
}
