import type { RouterInstance } from '@koa/router';
import sql from 'sql-template-tag';
import z from 'zod';
import { authenticator } from '../../authenticator.js';
import { runInTransaction } from '../../database.js';
import { AUTH_REQUIRED, registerPath } from '../../openapi.js';

export function attachDeleteMapAccessHandler(router: RouterInstance) {
  registerPath('/maps/{id}/writers/me', {
    delete: {
      summary:
        "Give up write access to another's map, taking it off the caller's list",
      tags: ['maps'],
      security: AUTH_REQUIRED,
      requestParams: {
        path: z.object({ id: z.string().nonempty() }),
      },
      responses: {
        204: {},
        401: {},
        404: { description: 'not a writer of such map' },
      },
    },
  });

  router.delete(
    '/:id/writers/me',
    authenticator(true, 'maps:write'),
    async (ctx) => {
      const { id } = ctx.params;

      const userId = ctx.state.user!.id;

      await runInTransaction(async (conn) => {
        const { affectedRows } = await conn.query<{ affectedRows: number }>(
          sql`DELETE FROM mapWriteAccess WHERE mapId = ${id} AND userId = ${userId}`,
        );

        if (!affectedRows) {
          ctx.throw(404, 'not a writer of such map');
        }

        await conn.query(
          sql`DELETE FROM mapTag WHERE mapId = ${id} AND userId = ${userId}`,
        );
      });

      ctx.status = 204;
    },
  );
}
