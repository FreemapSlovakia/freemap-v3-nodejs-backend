import { writeFile } from 'node:fs/promises';
import { RouterInstance } from '@koa/router';
import shortUuid from 'short-uuid';
import z from 'zod';
import { registerPath } from '../../openapi.js';
import { tracklogsDir } from '../../routers/tracklogs/constants.js';

const BodySchema = z.strictObject({ data: z.string().min(10) });

const ResponseSchema = z.strictObject({ uid: z.string() });

export function attachCreateTracklogHandler(router: RouterInstance) {
  registerPath('/tracklogs', {
    post: {
      summary: 'Upload a GPX tracklog',
      tags: ['tracklogs'],
      requestBody: {
        content: { 'application/json': { schema: BodySchema } },
      },
      responses: {
        201: {
          content: { 'application/json': { schema: ResponseSchema } },
        },
        400: {},
      },
    },
  });

  router.post('/', async (ctx) => {
    let body;

    try {
      body = BodySchema.parse(ctx.request.body);
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
