import { readFile, stat } from 'node:fs/promises';
import { RouterInstance } from '@koa/router';
import z from 'zod';
import { registerPath } from '../../openapi.js';
import { tracklogsDir } from '../tracklogs/constants.js';

const ResponseSchema = z.strictObject({
  uid: z.string(),
  data: z.string(),
  mediaType: z.string(),
});

export function attachGetTracklogHandler(router: RouterInstance) {
  registerPath('/tracklogs/{uid}', {
    get: {
      parameters: [
        {
          in: 'path',
          name: 'uid',
          required: true,
          schema: { type: 'string', pattern: '^[a-zA-Z0-9]*$' },
        },
      ],
      responses: {
        200: {
          content: {
            'application/json': {
              schema: ResponseSchema,
            },
          },
        },
        400: {},
        404: { description: 'gpx file not found' },
      },
    },
  });

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

    ctx.body = ResponseSchema.parse({
      uid: fileUID,
      data: b64gpx,
      mediaType: 'application/gpx+xml',
    });
  });
}
