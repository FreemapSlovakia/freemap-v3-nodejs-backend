const { dbMiddleware } = rootRequire('database');
const checkRequestMiddleware = rootRequire('checkRequestMiddleware');
const logger = rootRequire('logger');

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
        `SELECT RecordID, Created, ImagePath, Title, Description, Lat, Lon,
          (6371 * acos(cos(radians(?)) * cos(radians(Lat)) * cos(radians(Lon) - radians(?) ) + sin(radians(?)) * sin(radians(Lat)))) AS distance,
          nickname
          FROM fm_Attachment JOIN fm_User ON UserID = user_id
          WHERE Lat BETWEEN ? AND ? AND Lon BETWEEN ? AND ?
          HAVING distance <= ?
          ORDER BY distance
          LIMIT 10`,
        [lat, lon, lat, lat1, lat2, lon1, lon2, distance],
        (err, rows) => {
          if (err) {
            logger.error({ err }, 'Error selecting pictures.');
            res.status(500).end();
          } else {
            res.json(rows.map(({ RecordID, Created, ImagePath, Title, Description, Lat, Lon, nickname }) => ({
              id: RecordID,
              createdAt: Created.toISOString(),
              path: ImagePath,
              title: Title,
              description: Description,
              lat: Lat,
              lon: Lon,
              author: nickname,
            })));
          }
        },
      );
    },
  );
};
