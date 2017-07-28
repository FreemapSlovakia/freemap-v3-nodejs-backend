const uuidBase62 = require('uuid-base62');
const { promisify } = require('util');
const fs = require('fs');

const { TRACKLOGS_DIR } = require('~/routers/tracklogs/constants');
const createTracklogSchema = require('~/routers/tracklogs/createTracklogSchema.json');

const writeFileAsync = promisify(fs.writeFile);

module.exports = function attachCreateTracklogHandler(router) {
  router.post(
    '/',
    // checkRequestMiddleware({ method: 'POST', acceptsJson: true, schema: createTracklogSchema }),
    async (ctx) => {
      const b64gpx = ctx.request.body.data;
      const fileUID = uuidBase62.v4();
      const filePath = `${TRACKLOGS_DIR}/${fileUID}.b64.gpx`;

      await writeFileAsync(filePath, b64gpx);

      ctx.status = 201;
      ctx.body = { uid: fileUID };
    },
  );
};
