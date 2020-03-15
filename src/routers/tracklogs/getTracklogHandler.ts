import Router from '@koa/router';
import { promises as fs } from 'fs';
import { TRACKLOGS_DIR } from '../tracklogs/constants';

export function attachGetTracklogHandler(router: Router) {
  router.get('/:uid', async ctx => {
    const fileUID = ctx.params.uid;

    if (!/^[a-zA-Z0-9]*$/.test(fileUID)) {
      ctx.throw(404);
    }

    const filePath = `${TRACKLOGS_DIR}/${fileUID}.b64.gpx`;

    try {
      await fs.stat(filePath);
    } catch {
      ctx.throw(404);
    }

    const b64gpx = await fs.readFile(filePath, 'utf8');

    ctx.body = {
      uid: fileUID,
      data: b64gpx,
      mediaType: 'application/gpx+xml',
    };
  });
}
