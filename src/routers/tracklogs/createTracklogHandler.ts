import Router from '@koa/router';
import { writeFile } from 'node:fs/promises';
import uuidBase62 from 'uuid-base62';
import { bodySchemaValidator } from '../../requestValidators.js';
import { tracklogsDir } from '../../routers/tracklogs/constants.js';

export function attachCreateTracklogHandler(router: Router) {
  router.post(
    '/',
    bodySchemaValidator({
      type: 'object',
      required: ['data'],
      properties: {
        data: {
          type: 'string',
          minLength: 10,
        },
      },
    }),
    async (ctx) => {
      const b64gpx = ctx.request.body.data;
      const fileUID = uuidBase62.v4();
      const filePath = `${tracklogsDir}/${fileUID}.b64.gpx`;

      await writeFile(filePath, b64gpx);

      ctx.status = 201;
      ctx.body = { uid: fileUID };
    },
  );
}
