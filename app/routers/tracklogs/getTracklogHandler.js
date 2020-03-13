const fs = require('fs');
const { promisify } = require('util');
const { TRACKLOGS_DIR } = require('~/routers/tracklogs/constants');

const readFileAsync = promisify(fs.readFile);
const existsAsync = promisify(fs.exists);

module.exports = function attachGetTracklogHandler(router) {
  router.get('/:uid', async ctx => {
    const fileUID = ctx.params.uid;

    if (!/^[a-zA-Z0-9]*$/.test(fileUID)) {
      ctx.throw(404);
    }

    const filePath = `${TRACKLOGS_DIR}/${fileUID}.b64.gpx`;

    if (!(await existsAsync(filePath))) {
      ctx.throw(404);
    }

    const b64gpx = await readFileAsync(filePath, 'utf8');

    ctx.body = {
      uid: fileUID,
      data: b64gpx,
      mediaType: 'application/gpx+xml',
    };
  });
};
