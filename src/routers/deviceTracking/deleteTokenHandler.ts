import { RouterInstance } from '@koa/router';
import sql from 'sql-template-tag';
import z from 'zod';
import { authenticator } from '../../authenticator.js';
import { runInTransaction } from '../../database.js';
import { AUTH_REQUIRED, registerPath } from '../../openapi.js';
import { acceptValidator } from '../../requestValidators.js';

export function attachDeleteTokenHandler(router: RouterInstance) {
  registerPath('/tracking/access-tokens/{id}', {
    delete: {
      summary: 'Delete a tracking access token',
      tags: ['tracking'],
      security: AUTH_REQUIRED,
      requestParams: {
        path: z.object({
          id: z.uint32(),
        }),
      },
      responses: {
        204: {},
        403: {},
        404: { description: 'no such tracking access token' },
      },
    },
  });

  router.delete(
    '/access-tokens/:id',
    acceptValidator('application/json'),
    authenticator(true),
    async (ctx) => {
      await runInTransaction(async (conn) => {
        const [item] = await conn.query(sql`
          SELECT userId FROM trackingAccessToken
            JOIN trackingDevice ON (deviceId = trackingDevice.id)
            WHERE trackingAccessToken.id = ${ctx.params.id} FOR UPDATE
        `);

        if (!item) {
          ctx.throw(404, 'no such tracking access token');
        }

        if (!ctx.state.user!.isAdmin && item.userId !== ctx.state.user!.id) {
          ctx.throw(403);
        }

        await conn.query(
          sql`DELETE FROM trackingAccessToken WHERE id = ${ctx.params.id}`,
        );
      });

      ctx.status = 204;
    },
  );
}
