const { dbMiddleware } = require('~/database');
const { fromDb, fields } = require('~/routers/gallery/galleryCommons');
const { acceptValidator, queryValidator, queryAdapter } = require('~/requestValidators');

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
  const { lat, lon, distance, userId, tag } = ctx.query;

  // cca 1 degree
  const lat1 = lat - (distance / 43);
  const lat2 = lat + (distance / 43);
  const lon1 = lon - distance / Math.abs(Math.cos(lat * Math.PI / 180) * 43);
  const lon2 = lon + distance / Math.abs(Math.cos(lat * Math.PI / 180) * 43);

  const { db } = ctx.state;

  const rows = await db.query(
    `SELECT ${fields},
      (6371 * acos(cos(radians(${lat})) * cos(radians(picture.lat)) * cos(radians(picture.lon) - radians(${lon}) ) + sin(radians(${lat})) * sin(radians(picture.lat)))) AS distance
      FROM picture
      JOIN user ON userId = user.id
      ${tag ? `JOIN pictureTag ON pictureId = picture.id AND pictureTag.name = ${db.escape(tag)}` : ''}
      WHERE picture.lat BETWEEN ${lat1} AND ${lat2} AND picture.lon BETWEEN ${lon1} AND ${lon2} ${userId ? `AND picture.userId = ${userId}` : ''}
      HAVING distance <= ${distance}
      ORDER BY distance
      LIMIT 50`,
  );

  ctx.body = rows.map(row => fromDb(row));
}

async function byBbox(ctx) {
  const { bbox: [minLon, minLat, maxLon, maxLat], userId, tag } = ctx.query;

  const { db } = ctx.state;

  ctx.body = await db.query(
    `SELECT lat, lon
      FROM picture
      ${tag ? `JOIN pictureTag ON pictureId = id AND pictureId.name = ${db.escape(tag)}` : ''}
      WHERE lat BETWEEN ${minLat} AND ${maxLat} AND lon BETWEEN ${minLon} AND ${maxLon} ${userId ? ` AND userId = ${userId}` : ''}`,
  );
}
