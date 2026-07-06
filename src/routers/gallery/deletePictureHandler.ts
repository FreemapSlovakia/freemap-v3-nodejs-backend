import { unlink } from 'node:fs/promises';
import type { RouterInstance } from '@koa/router';
import sql from 'sql-template-tag';
import z from 'zod';
import { authenticator } from '../../authenticator.js';
import { runInTransaction } from '../../database.js';
import { AUTH_REQUIRED, registerPath } from '../../openapi.js';
import { isOwnerOrRole } from '../../roles.js';
import { picturesDir } from '../gallery/constants.js';

export function attachDeletePictureHandler(router: RouterInstance) {
  registerPath('/gallery/pictures/{id}', {
    delete: {
      summary: 'Delete a gallery picture',
      tags: ['gallery'],
      security: AUTH_REQUIRED,
      requestParams: {
        path: z.object({
          id: z.uint32(),
        }),
      },
      responses: {
        204: {},
        401: {},
        403: {},
        404: { description: 'no such picture' },
      },
    },
  });

  router.delete('/pictures/:id', authenticator(true), async (ctx) => {
    const pathname = await runInTransaction(async (conn) => {
      const rows = await conn.query<{ pathname: string; userId: number }[]>(
        sql`SELECT pathname, userId FROM picture WHERE id = ${ctx.params.id} FOR UPDATE`,
      );

      if (rows.length === 0) {
        ctx.throw(404, 'no such picture');
      }

      if (!isOwnerOrRole(ctx.state.user, rows[0].userId, 'galleryModerator')) {
        ctx.throw(403);
      }

      await conn.query<unknown>(
        sql`DELETE FROM picture WHERE id = ${ctx.params.id}`,
      );

      return rows[0].pathname;
    });

    await unlink(`${picturesDir}/${pathname}`);

    ctx.status = 204;
  });
}
