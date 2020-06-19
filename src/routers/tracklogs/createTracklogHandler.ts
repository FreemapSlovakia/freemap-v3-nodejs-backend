import Router from '@koa/router';
import uuidBase62 from 'uuid-base62';
import { promises as fs } from 'fs';
import { tracklogsDir } from '../../routers/tracklogs/constants';
import { bodySchemaValidator } from '../../requestValidators';

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

      await fs.writeFile(filePath, b64gpx);

      ctx.status = 201;
      ctx.body = { uid: fileUID };
    },
  );
}
