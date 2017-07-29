const { dbMiddleware } = require('~/database');
const { fromDb, fields } = require('~/routers/gallery/galleryCommons');
const { queryValidator, queryAdapter } = require('~/requestValidators');

module.exports = function attachGetPicturesInRadiusHandler(router) {
  router.get(
    '/pictures',
    queryAdapter({
      lat: parseFloat,
      lon: parseFloat,
      distance: parseFloat,
    }),
    queryValidator({
      lat: v => v >= -90 && v <= 90 || 'lat must be between -90 and 90',
      lon: v => v >= -180 && v <= 180 || 'lon must be between -180 and 180',
      distance: v => v > 0 || 'distance must be positive',
    }),
    dbMiddleware,
    async (ctx) => {
      const { lat, lon, distance } = ctx.query;

      // cca 1 degree
      const lat1 = lat - (distance / 43);
      const lat2 = lat + (distance / 43);
      const lon1 = lon - distance / Math.abs(Math.cos(lat * Math.PI / 180) * 43);
      const lon2 = lon + distance / Math.abs(Math.cos(lat * Math.PI / 180) * 43);

      const rows = await ctx.state.db.query(
        `SELECT ${fields},
          (6371 * acos(cos(radians(?)) * cos(radians(fm_Attachment.Lat)) * cos(radians(fm_Attachment.Lon) - radians(?) ) + sin(radians(?)) * sin(radians(fm_Attachment.Lat)))) AS distance
          FROM fm_Attachment JOIN fm_User ON UserID = user_id
          WHERE fm_Attachment.Lat BETWEEN ? AND ? AND fm_Attachment.Lon BETWEEN ? AND ?
          HAVING distance <= ?
          ORDER BY distance
          LIMIT 50`,
        [lat, lon, lat, lat1, lat2, lon1, lon2, distance],
      );

      ctx.body = rows.map(row => fromDb(row));
    },
  );
};
