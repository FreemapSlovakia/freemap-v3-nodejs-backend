import type { RouterInstance } from '@koa/router';
import sql from 'sql-template-tag';
import z from 'zod';
import { authenticator } from '../../authenticator.js';
import { runInTransaction } from '../../database.js';
import { AUTH_REQUIRED, registerPath } from '../../openapi.js';
import { acceptValidator } from '../../requestValidators.js';
import { isOwnerOrRole } from '../../roles.js';
import { idParam } from '../../routeParams.js';

export function attachDeleteDeviceHandler(router: RouterInstance) {
  registerPath('/tracking/devices/{id}', {
    delete: {
      summary: 'Delete a tracking device',
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
        404: { description: 'no such tracking device' },
      },
    },
  });

  router.delete(
    '/devices/:id',
    acceptValidator('application/json'),
    authenticator(true, 'tracking:write'),
    async (ctx) => {
      const id = idParam(ctx, 'no such tracking device');

      await runInTransaction(async (conn) => {
        const [item] = await conn.query<{ userId: number }[]>(
          sql`SELECT userId FROM trackingDevice WHERE id = ${id} FOR UPDATE`,
        );

        if (!item) {
          ctx.throw(404, 'no such tracking device');
        }

        if (!isOwnerOrRole(ctx.state.user, item.userId, 'trackingManager')) {
          ctx.throw(403);
        }

        await conn.query<unknown>(
          sql`DELETE FROM trackingDevice WHERE id = ${id}`,
        );
      });

      ctx.status = 204;
    },
  );
}
