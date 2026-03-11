import { RouterInstance } from '@koa/router';
import sql from 'sql-template-tag';
import z from 'zod';
import { authenticator } from '../../authenticator.js';
import { runInTransaction } from '../../database.js';
import { AUTH_REQUIRED, registerPath } from '../../openapi.js';
import { acceptValidator } from '../../requestValidators.js';

export function attachDeleteMapHandler(router: RouterInstance) {
  registerPath('/maps/{id}', {
    delete: {
      summary: 'Delete a map',
      tags: ['maps'],
      security: AUTH_REQUIRED,
      requestParams: {
        path: z.object({
          id: z.string().nonempty(),
        }),
      },
      responses: {
        204: {},
        401: {},
        403: {},
        404: { description: 'no such map' },
      },
    },
  });

  router.delete(
    '/:id',
    acceptValidator('application/json'),
    authenticator(true),
    async (ctx) => {
      await runInTransaction(async (conn) => {
        const [item] = await conn.query(
          sql`SELECT userId FROM map WHERE id = ${ctx.params.id} FOR UPDATE`,
        );

        if (!item) {
          ctx.throw(404, 'no such map');
        }

        if (!ctx.state.user!.isAdmin && item.userId !== ctx.state.user!.id) {
          ctx.throw(403);
        }

        await conn.query(sql`DELETE FROM map WHERE id = ${ctx.params.id}`);
      });

      ctx.status = 204;
    },
  );
}
