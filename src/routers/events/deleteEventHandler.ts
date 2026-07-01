import { RouterInstance } from '@koa/router';
import sql from 'sql-template-tag';
import z from 'zod';
import { authenticator } from '../../authenticator.js';
import { runInTransaction } from '../../database.js';
import { AUTH_REQUIRED, registerPath } from '../../openapi.js';
import { acceptValidator } from '../../requestValidators.js';
import { isOwnerOrRole } from '../../roles.js';

export function attachDeleteEventHandler(router: RouterInstance) {
  registerPath('/events/{id}', {
    delete: {
      summary: 'Delete an event (owner only)',
      tags: ['events'],
      security: AUTH_REQUIRED,
      requestParams: {
        path: z.object({ id: z.string().nonempty() }),
      },
      responses: {
        204: {},
        401: {},
        403: {},
        404: { description: 'no such event' },
      },
    },
  });

  router.delete(
    '/:id',
    acceptValidator('application/json'),
    authenticator(true),
    async (ctx) => {
      await runInTransaction(async (conn) => {
        const [item] = z
          .array(z.object({ ownerId: z.uint32() }))
          .max(1)
          .parse(
            await conn.query<unknown>(
              sql`SELECT ownerId FROM event WHERE id = ${ctx.params.id} FOR UPDATE`,
            ),
          );

        if (!item) {
          ctx.throw(404, 'no such event');
        }

        if (!isOwnerOrRole(ctx.state.user, item.ownerId, 'mapModerator')) {
          ctx.throw(403);
        }

        await conn.query<unknown>(
          sql`DELETE FROM event WHERE id = ${ctx.params.id}`,
        );
      });

      ctx.status = 204;
    },
  );
}
