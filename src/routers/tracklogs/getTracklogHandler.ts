import { readFile, stat } from 'node:fs/promises';
import { RouterInstance } from '@koa/router';
import { tracklogsDir } from '../tracklogs/constants.js';

export function attachGetTracklogHandler(router: RouterInstance) {
  router.get('/:uid', async (ctx) => {
    const fileUID = ctx.params.uid;

    if (!/^[a-zA-Z0-9]*$/.test(fileUID)) {
      ctx.throw(400, 'invalid id format');
    }

    const filePath = `${tracklogsDir}/${fileUID}.b64.gpx`;

    try {
      await stat(filePath);
    } catch {
      ctx.throw(404, 'gpx file not found');
    }

    const b64gpx = await readFile(filePath, 'utf8');

    ctx.body = {
      uid: fileUID,
      data: b64gpx,
      mediaType: 'application/gpx+xml',
    };
  });
}
