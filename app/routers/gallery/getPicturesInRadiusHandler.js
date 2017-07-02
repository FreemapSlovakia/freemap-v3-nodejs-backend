const { dbMiddleware } = rootRequire('database');
const checkRequestMiddleware = rootRequire('checkRequestMiddleware');
const logger = rootRequire('logger');
const { fromDb, fields } = rootRequire('routers/gallery/galleryCommons');

module.exports = function attachGetPicturesInRadiusHandler(router) {
  router.all(
    '/pictures',
    checkRequestMiddleware({ method: 'GET' }),
    dbMiddleware,
    (req, res) => {
      const { lat: latStr, lon: lonStr, distance: distanceStr } = req.query;

      const lat = parseFloat(latStr);
      const lon = parseFloat(lonStr);
      const distance = parseFloat(distanceStr);

      if ([lat, lon, distance].some(v => isNaN(v))) {
        res.status(400).json('invalid_query_parameters');
        return;
      }

      // cca 1 degree
      const lat1 = lat - (distance / 43);
      const lat2 = lat + (distance / 43);
      const lon1 = lon - distance / Math.abs(Math.cos(lat * Math.PI / 180) * 43);
      const lon2 = lon + distance / Math.abs(Math.cos(lat * Math.PI / 180) * 43);

      req.db.query(
        `SELECT ${fields},
          (6371 * acos(cos(radians(?)) * cos(radians(fm_Attachment.Lat)) * cos(radians(fm_Attachment.Lon) - radians(?) ) + sin(radians(?)) * sin(radians(fm_Attachment.Lat)))) AS distance,
          FROM fm_Attachment JOIN fm_User ON UserID = user_id
          WHERE fm_Attachment.Lat BETWEEN ? AND ? AND fm_Attachment.Lon BETWEEN ? AND ?
          HAVING distance <= ?
          ORDER BY distance
          LIMIT 10`,
        [lat, lon, lat, lat1, lat2, lon1, lon2, distance],
        (err, rows) => {
          if (err) {
            logger.error({ err }, 'Error selecting pictures.');
            res.status(500).end();
          } else {
            res.json(rows.map(row => fromDb(row)));
          }
        },
      );
    },
  );
};
