const { dbMiddleware } = require('~/database');
const { fromDb, fields } = require('~/routers/gallery/galleryCommons');
const { acceptValidator, queryValidator, queryAdapter } = require('~/requestValidators');

const radiusQueryValidator = queryValidator({
  lat: v => v >= -90 && v <= 90 || 'lat must be between -90 and 90',
  lon: v => v >= -180 && v <= 180 || 'lon must be between -180 and 180',
  distance: v => v > 0 || 'distance must be positive',
});

const bboxQueryValidator = queryValidator({
  bbox: v => v && v.length === 4 || 'invalid bbox',
  excludeBbox: v => v === undefined || v.length === 4 || 'invalid excludeBbox',
});

module.exports = function attachGetPicturesInRadiusHandler(router) {
  router.get(
    '/pictures',
    acceptValidator('application/json'),
    queryAdapter({
      lat: parseFloat,
      lon: parseFloat,
      distance: parseFloat,

      bbox: x => x.split(',').map(parseFloat),
      excludeBbox: x => x.split(',').map(parseFloat),
    }),
    queryValidator({
      by: v => ['radius', 'bbox'].includes(v) || '"by" must be either "radius" or "bbox"',
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
  const { lat, lon, distance } = ctx.query;

  // cca 1 degree
  const lat1 = lat - (distance / 43);
  const lat2 = lat + (distance / 43);
  const lon1 = lon - distance / Math.abs(Math.cos(lat * Math.PI / 180) * 43);
  const lon2 = lon + distance / Math.abs(Math.cos(lat * Math.PI / 180) * 43);

  const rows = await ctx.state.db.query(
    `SELECT ${fields},
          (6371 * acos(cos(radians(?)) * cos(radians(picture.lat)) * cos(radians(picture.lon) - radians(?) ) + sin(radians(?)) * sin(radians(picture.lat)))) AS distance
          FROM picture JOIN user ON userId = user.id
          WHERE picture.lat BETWEEN ? AND ? AND picture.lon BETWEEN ? AND ?
          HAVING distance <= ?
          ORDER BY distance
          LIMIT 50`,
    [lat, lon, lat, lat1, lat2, lon1, lon2, distance],
  );

  ctx.body = rows.map(row => fromDb(row));  
}

async function byBbox(ctx) {
  const [minLon, minLat, maxLon, maxLat] = ctx.query.bbox;

  const params = [minLat, maxLat, maxLon, maxLon];

  if (ctx.query.excludeBbox) {
    const [exMinLon, exMinLat, exMaxLon, exMaxLat] = ctx.query.excludeBbox;
    params.push(...[exMinLat, exMaxLat, exMinLon, exMaxLon]);
  }

  ctx.body = await ctx.state.db.query(
    `SELECT lat, lon FROM picture WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?
      ${ctx.query.excludeBbox ? 'AND NOT (lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?)' : ''}`,
    [minLat, maxLat, minLon, maxLon],
  );
}
