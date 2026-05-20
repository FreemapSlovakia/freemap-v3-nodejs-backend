import { RouterInstance } from '@koa/router';
import calculate from 'etag';
import sql from 'sql-template-tag';
import z from 'zod';
import { pool } from '../../database.js';
import { registerPath } from '../../openapi.js';

export function attachGetUserPictureHandler(router: RouterInstance) {
  registerPath('/auth/users/{id}/picture', {
    get: {
      summary: 'Get the profile picture for a user',
      tags: ['auth'],
      requestParams: {
        path: z.object({
          id: z.uint32(),
        }),
      },
      responses: {
        200: {
          content: {
            'image/webp': {},
          },
        },
        404: { description: 'no such user or no picture' },
      },
    },
  });

  router.get('/users/:id/picture', async (ctx) => {
    const id = Number(ctx.params.id);

    if (!Number.isInteger(id) || id <= 0) {
      ctx.throw(404, 'no such user');
    }

    const [row] = await pool.query<{ picture: Buffer | null }[]>(
      sql`SELECT picture FROM user WHERE id = ${id}`,
    );

    const picture = row?.picture;

    if (!picture) {
      return ctx.throw(404, 'no picture');
    }

    ctx.response.etag = calculate(picture);

    ctx.set('Cache-Control', 'public, max-age=300, must-revalidate');

    ctx.type = 'image/webp';

    if (ctx.fresh) {
      ctx.status = 304;

      return;
    }

    ctx.status = 200;

    ctx.body = picture;
  });
}
