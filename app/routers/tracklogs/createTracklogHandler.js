const uuidBase62 = require('uuid-base62');
const fs = require('fs');

const checkRequestMiddleware = require('~/checkRequestMiddleware');
const logger = require('~/logger');

const { TRACKLOGS_DIR } = require('~/routers/tracklogs/constants');
const createTracklogSchema = require('~/routers/tracklogs/createTracklogSchema.json');

module.exports = function attachCreateTracklogHandler(router) {
  router.all(
    '/',
    checkRequestMiddleware({ method: 'POST', acceptsJson: true, schema: createTracklogSchema }),
    (req, res) => {
      const b64gpx = req.body.data;
      const fileUID = uuidBase62.v4();
      const filePath = `${TRACKLOGS_DIR}/${fileUID}.b64.gpx`;
      fs.writeFile(filePath, b64gpx, (err) => {
        if (err) {
          logger.error({ err }, `Failed to save gpx file to "${filePath}".`);
          res.status(500);
        } else {
          res.status(201).json({ uid: fileUID });
        }
      });
    },
  );
};
