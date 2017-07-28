const { dbMiddleware } = require('~/database');
const { fromDb, fields } = require('~/routers/gallery/galleryCommons');

module.exports = function attachGetPicturesInRadiusHandler(router) {
  router.get(
    '/pictures',
    dbMiddleware,
    async (ctx) => {
      const { lat: latStr, lon: lonStr, distance: distanceStr } = ctx.query;

      const lat = parseFloat(latStr);
      const lon = parseFloat(lonStr);
      const distance = parseFloat(distanceStr);

      if ([lat, lon, distance].some(v => isNaN(v))) {
        ctx.status = 400;
        return;
      }

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
