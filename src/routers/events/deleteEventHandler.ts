import type { RouterInstance } from '@koa/router';
import sql from 'sql-template-tag';
import z from 'zod';
import { authenticator } from '../../authenticator.js';
import { runInTransaction } from '../../database.js';
import { AUTH_REQUIRED, registerPath } from '../../openapi.js';
import { acceptValidator } from '../../requestValidators.js';
import { assertMapWritable } from './mapAccess.js';

export function attachDeleteEventHandler(router: RouterInstance) {
  registerPath('/events/{mapId}', {
    delete: {
      summary: 'Stop a map being an event',
      tags: ['events'],
      security: AUTH_REQUIRED,
      requestParams: {
        path: z.object({ mapId: z.string().nonempty() }),
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
    '/:mapId',
    acceptValidator('application/json'),
    authenticator(true),
    async (ctx) => {
      await runInTransaction(async (conn) => {
        await assertMapWritable(ctx, conn, ctx.params.mapId);

        await conn.query<unknown>(
          sql`DELETE FROM mapEvent WHERE mapId = ${ctx.params.mapId}`,
        );
      });

      ctx.status = 204;
    },
  );
}
