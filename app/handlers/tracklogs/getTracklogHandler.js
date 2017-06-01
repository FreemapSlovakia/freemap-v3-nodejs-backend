const fs = require('fs');

const logger = rootRequire('logger');
const checkRequestMiddleware = rootRequire('checkRequestMiddleware');

const USER_DATA_DIR = `${rootDir}/user_data`;

module.exports = function attachGetTracklogHandler(app) {
  app.all('/tracklogs/:uid',
    checkRequestMiddleware({ method: 'GET' }),
    (req, res) => {
      const fileUID = req.params.uid;
      if (!fileUID.match(/^[a-zA-Z0-9]*$/)) {
        res.status(400).json({ error: 'invalid_uid' });
      } else {
        const filePath = `${USER_DATA_DIR}/tracklogs/${fileUID}.b64.gpx`;
        fs.readFile(filePath, 'utf8', (err, b64gpx) => {
          if (err) {
            logger.error({ err }, `Error reading file "${filePath}".`);
            res.status(404);
          } else {
            res.status(200).json({
              uid: fileUID,
              data: b64gpx,
              mediaType: 'application/gpx+xml',
            });
          }
        });
      }
    },
  );
};
