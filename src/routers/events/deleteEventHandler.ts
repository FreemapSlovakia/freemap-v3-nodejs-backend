import type { RouterInstance } from '@koa/router';
import sql from 'sql-template-tag';
import z from 'zod';
import { authenticator } from '../../authenticator.js';
import { runInTransaction } from '../../database.js';
import { appLogger } from '../../logger.js';
import { AUTH_REQUIRED, registerPath } from '../../openapi.js';
import { acceptValidator } from '../../requestValidators.js';
import { removeCover } from './cover.js';
import { canWriteEvent } from './types.js';

const logger = appLogger.child({ module: 'deleteEvent' });

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
    authenticator(true, 'events:write'),
    async (ctx) => {
      const cover = await runInTransaction(async (conn) => {
        const [item] = z
          .array(z.object({ userId: z.uint32(), cover: z.string().nullable() }))
          .max(1)
          .parse(
            await conn.query<unknown>(
              sql`SELECT userId, cover FROM event WHERE id = ${ctx.params.id} FOR UPDATE`,
            ),
          );

        if (!item) {
          ctx.throw(404, 'no such event');
        }

        if (!canWriteEvent(ctx.state.user, item)) {
          ctx.throw(403);
        }

        await conn.query<unknown>(
          sql`DELETE FROM event WHERE id = ${ctx.params.id}`,
        );

        return item.cover;
      });

      if (cover) {
        await removeCover(cover, logger);
      }

      ctx.status = 204;
    },
  );
}
