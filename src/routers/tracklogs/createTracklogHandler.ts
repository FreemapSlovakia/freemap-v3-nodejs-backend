import { writeFile } from 'node:fs/promises';
import shortUuid from 'short-uuid';
import { assert, tags } from 'typia';
import { tracklogsDir } from '../../routers/tracklogs/constants.js';
import { RouterInstance } from '@koa/router';

export function attachCreateTracklogHandler(router: RouterInstance) {
  router.post('/', async (ctx) => {
    type Body = {
      data: string & tags.MinLength<10>;
    };

    let body;

    try {
      body = assert<Body>(ctx.request.body);
    } catch (err) {
      return ctx.throw(400, err as Error);
    }

    const b64gpx = body.data;
    const fileUID = shortUuid.generate();
    const filePath = `${tracklogsDir}/${fileUID}.b64.gpx`;

    await writeFile(filePath, b64gpx);

    ctx.status = 201;
    ctx.body = { uid: fileUID };
  });
}
