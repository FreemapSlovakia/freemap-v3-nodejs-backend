const uuidBase62 = require('uuid-base62');
const fs = require('fs');

const checkRequestMiddleware = rootRequire('checkRequestMiddleware');
const logger = rootRequire('logger');

const createTracklogSchema = rootRequire('handlers/tracklogs/createTracklogSchema.json');

const USER_DATA_DIR = `${rootDir}/user_data`;

module.exports = function attachCreateTracklogHandler(app) {
  app.all(
    '/tracklogs',
    checkRequestMiddleware({ method: 'POST', acceptsJson: true, schema: createTracklogSchema }),
    (req, res) => {
      const b64gpx = req.body.data;
      const fileUID = uuidBase62.v4();
      const filePath = `${USER_DATA_DIR}/tracklogs/${fileUID}.b64.gpx`;
      fs.writeFile(filePath, b64gpx, (err) => {
        if (err) {
          logger.error({ err }, `Failed to save gpx file to "${filePath}".`);
          res.status(500).json({ error: err });
        } else {
          res.status(201).json({ uid: fileUID });
        }
      });
    },
  );
};
