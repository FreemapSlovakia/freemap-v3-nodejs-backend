const fs = require('fs');

const logger = rootRequire('logger');
const checkRequestMiddleware = rootRequire('checkRequestMiddleware');

const { TRACKLOGS_DIR } = rootRequire('routers/tracklogs/constants');

module.exports = function attachGetTracklogHandler(router) {
  router.all('/:uid',
    checkRequestMiddleware({ method: 'GET' }),
    (req, res) => {
      const fileUID = req.params.uid;
      if (!fileUID.match(/^[a-zA-Z0-9]*$/)) {
        res.status(400).json({ error: 'invalid_uid' });
      } else {
        const filePath = `${TRACKLOGS_DIR}/${fileUID}.b64.gpx`;
        fs.readFile(filePath, 'utf8', (err, b64gpx) => {
          if (err) {
            logger.error({ err }, `Error reading file "${filePath}".`);
            res.status(404).end();
          } else {
            res.json({
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
