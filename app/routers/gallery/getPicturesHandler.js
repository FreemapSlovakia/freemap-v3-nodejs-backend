const { dbMiddleware } = require('~/database');
const { acceptValidator, queryValidator, queryAdapter } = require('~/requestValidators');
const { ratingSubquery } = require('./ratingConstants');

const globalValidationRules = {
  userId: v => v === null || !isNaN(v) || 'invalid userId',
  ratingFrom: v => v === null || !isNaN(v) || 'invalid ratingFrom',
  ratingTo: v => v === null || !isNaN(v) || 'invalid ratingTo',
  takenAtFrom: v => v === null || !isNaN(v) || 'invalid takenAtFrom',
  takenAtTo: v => v === null || !isNaN(v) || 'invalid takenAtTo',
};

const radiusQueryValidator = queryValidator(Object.assign({
  lat: v => v >= -90 && v <= 90 || 'lat must be between -90 and 90',
  lon: v => v >= -180 && v <= 180 || 'lon must be between -180 and 180',
  distance: v => v > 0 || 'distance must be positive',
}), globalValidationRules);

const bboxQueryValidator = queryValidator(Object.assign({
  bbox: v => v && v.length === 4 && v.every(x => !isNaN(x)) || 'invalid bbox',
}), globalValidationRules);

const qvs = {
  radius: radiusQueryValidator,
  bbox: bboxQueryValidator,
};

const methods = {
  radius: byRadius,
  bbox: byBbox,
};

module.exports = function attachGetPicturesHandler(router) {
  router.get(
    '/pictures',
    acceptValidator('application/json'),
    queryAdapter({
      lat: parseFloat,
      lon: parseFloat,
      distance: parseFloat,

      bbox: x => (x === undefined ? null : x.split(',').map(parseFloat)),
      userId: x => (x ? parseInt(x, 10) : null),

      ratingFrom: x => (x ? parseFloat(x) : null),
      ratingTo: x => (x ? parseFloat(x) : null),
      takenAtFrom: x => (x ? new Date(x) : null),
      takenAtTo: x => (x ? new Date(x) : null),
    }),
    queryValidator({
      by: v => ['radius', 'bbox'].includes(v) || '"by" must be one of "radius", "bbox"',
      userId: userId => !userId || userId > 0 || 'invalid userId',
    }),
    async (ctx, next) => {
      await qvs[ctx.query.by](ctx, next);
    },
    dbMiddleware,
    async (ctx) => {
      await methods[ctx.query.by](ctx);
    },
  );
};

async function byRadius(ctx) {
  const { lat, lon, distance, userId, tag, ratingFrom, ratingTo, takenAtFrom, takenAtTo } = ctx.query;

  // cca 1 degree
  const lat1 = lat - (distance / 43);
  const lat2 = lat + (distance / 43);
  const lon1 = lon - distance / Math.abs(Math.cos(lat * Math.PI / 180) * 43);
  const lon2 = lon + distance / Math.abs(Math.cos(lat * Math.PI / 180) * 43);

  const { db } = ctx.state;

  const sql =
    `SELECT id,
      (6371 * acos(cos(radians(${lat})) * cos(radians(lat)) * cos(radians(lon) - radians(${lon}) ) + sin(radians(${lat})) * sin(radians(lat)))) AS distance
      ${ratingFrom || ratingTo ? `, ${ratingSubquery}` : ''}
      FROM picture
      ${tag ? `JOIN pictureTag ON pictureId = picture.id AND pictureTag.name = ${db.escape(tag)}` : ''}
      WHERE lat BETWEEN ${lat1} AND ${lat2} AND lon BETWEEN ${lon1} AND ${lon2}
      ${takenAtFrom ? `AND takenAt >= '${toSqlDate(takenAtFrom)}'` : ''}
      ${takenAtTo ? `AND takenAt <= '${toSqlDate(takenAtTo)}'` : ''}
      ${userId ? `AND userId = ${userId}` : ''}
      HAVING distance <= ${distance}
      ${ratingFrom === null ? '' : `AND rating >= ${ratingFrom}`}
      ${ratingTo === null ? '' : `AND rating <= ${ratingTo}`}
      ORDER BY distance
      LIMIT 100`;

  const rows = await db.query(sql);

  ctx.body = rows.map(({ id }) => ({ id }));
}

function toSqlDate(d) {
  return isNaN(d) ? d : d.toISOString().replace('T', ' ').replace(/(\.\d*)?Z$/, '');
}

async function byBbox(ctx) {
  const { bbox: [minLon, minLat, maxLon, maxLat], userId, tag, ratingFrom, ratingTo, takenAtFrom, takenAtTo } = ctx.query;

  const { db } = ctx.state;

  const sql = `SELECT lat, lon ${ratingFrom || ratingTo ? `, ${ratingSubquery}` : ''}
    FROM picture
    ${tag ? `JOIN pictureTag ON pictureTag.pictureId = picture.id AND name = ${db.escape(tag)}` : ''}
    WHERE lat BETWEEN ${minLat} AND ${maxLat} AND lon BETWEEN ${minLon} AND ${maxLon}
    ${takenAtFrom ? `AND takenAt >= '${toSqlDate(takenAtFrom)}'` : ''}
    ${takenAtTo ? `AND takenAt <= '${toSqlDate(takenAtTo)}'` : ''}
    ${userId ? `AND userId = ${userId}` : ''}
    ${ratingFrom === null ? '' : `HAVING rating >= ${ratingFrom}`}
    ${ratingTo === null ? '' : `${ratingTo ? 'AND' : 'HAVING'} rating <= ${ratingTo}`}
  `;

  const rows = await db.query(sql);

  ctx.body = rows.map(({ lat, lon }) => ({ lat, lon }));
}
