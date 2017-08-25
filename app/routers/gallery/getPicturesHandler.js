const { dbMiddleware } = require('~/database');
const { acceptValidator, queryValidator, queryAdapter } = require('~/requestValidators');
const { ratingSubquery, ratingExp } = require('./ratingConstants');

const radiusQueryValidator = queryValidator({
  lat: v => v >= -90 && v <= 90 || 'lat must be between -90 and 90',
  lon: v => v >= -180 && v <= 180 || 'lon must be between -180 and 180',
  distance: v => v > 0 || 'distance must be positive',
});

const bboxQueryValidator = queryValidator({
  bbox: v => v && v.length === 4 && v.every(x => !isNaN(x)) || 'invalid bbox',
});

module.exports = function attachGetPicturesHandler(router) {
  router.get(
    '/pictures',
    acceptValidator('application/json'),
    queryAdapter({
      lat: parseFloat,
      lon: parseFloat,
      distance: parseFloat,

      bbox: x => x.split(',').map(parseFloat),
      userId: parseInt,
    }),
    queryValidator({
      by: v => ['radius', 'bbox'].includes(v) || '"by" must be either "radius" or "bbox"',
      userId: userId => !userId || userId > 0 || 'invalid userId',
    }),
    async (ctx, next) => {
      await (ctx.query.by === 'radius' ? radiusQueryValidator : bboxQueryValidator)(ctx, next);
    },
    dbMiddleware,
    async (ctx) => {
      if (ctx.query.by === 'radius') {
        await byRadius(ctx);
      } else {
        await byBbox(ctx);
      }
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

  const rows = await db.query(
    `SELECT id,
      (6371 * acos(cos(radians(${lat})) * cos(radians(lat)) * cos(radians(lon) - radians(${lon}) ) + sin(radians(${lat})) * sin(radians(lat)))) AS distance
      ${ratingFrom || ratingTo ? `, ${ratingSubquery}` : ''}
      FROM picture
      ${tag ? `JOIN pictureTag ON pictureId = picture.id AND pictureTag.name = ${db.escape(tag)}` : ''}
      WHERE lat BETWEEN ${lat1} AND ${lat2} AND lon BETWEEN ${lon1} AND ${lon2}
      ${takenAtFrom ? `AND takenAt >= ${db.escape(takenAtFrom)}` : ''}
      ${takenAtTo ? `AND takenAt <= ${db.escape(takenAtTo)}` : ''}
      ${userId ? `AND userId = ${userId}` : ''}
      HAVING distance <= ${distance}
      ${ratingFrom ? `AND rating >= ${parseFloat(ratingFrom, 10)}` : ''}
      ${ratingTo ? `AND rating <= ${parseFloat(ratingTo, 10)}` : ''}
      ORDER BY distance
      LIMIT 50`,
  );

  ctx.body = rows.map(({ id }) => ({ id }));
}

async function byBbox(ctx) {
  const { bbox: [minLon, minLat, maxLon, maxLat], userId, tag, ratingFrom, ratingTo, takenAtFrom, takenAtTo } = ctx.query;

  const { db } = ctx.state;

  const sql = `SELECT lat, lon ${ratingFrom || ratingTo ? `, ${ratingSubquery}` : ''}
    FROM picture
    ${tag ? `JOIN pictureTag ON pictureTag.pictureId = picture.id AND name = ${db.escape(tag)}` : ''}
    WHERE lat BETWEEN ${minLat} AND ${maxLat} AND lon BETWEEN ${minLon} AND ${maxLon}
    ${takenAtFrom ? `AND takenAt >= ${db.escape(takenAtFrom)}` : ''}
    ${takenAtTo ? `AND takenAt <= ${db.escape(takenAtTo)}` : ''}
    ${userId ? `AND userId = ${userId}` : ''}
    ${ratingFrom ? `HAVING rating >= ${parseFloat(ratingFrom)} ` : ''}
    ${ratingTo ? `${ratingTo ? 'AND' : 'HAVING'} rating <= ${parseFloat(ratingTo)} ` : ''}
  `;

  const rows = await db.query(sql);

  ctx.body = rows.map(({ lat, lon }) => ({ lat, lon }));
}
