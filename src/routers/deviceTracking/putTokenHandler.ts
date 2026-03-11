import { RouterInstance } from '@koa/router';
import sql from 'sql-template-tag';
import z from 'zod';
import { authenticator } from '../../authenticator.js';
import { runInTransaction } from '../../database.js';
import { AUTH_REQUIRED, registerPath } from '../../openapi.js';
import { acceptValidator } from '../../requestValidators.js';
import { TokenBodySchema } from '../../types.js';

export function attachPutTokenHandler(router: RouterInstance) {
  registerPath('/tracking/access-tokens/{id}', {
    put: {
      summary: 'Update a tracking access token',
      tags: ['tracking'],
      security: AUTH_REQUIRED,
      requestParams: {
        path: z.object({
          id: z.uint32(),
        }),
      },
      requestBody: {
        content: {
          'application/json': {
            schema: TokenBodySchema,
          },
        },
      },
      responses: {
        204: {},
        403: {},
        404: { description: 'no such tracking access token' },
      },
    },
  });

  router.put(
    '/access-tokens/:id',
    acceptValidator('application/json'),
    authenticator(true),
    async (ctx) => {
      let body;

      try {
        body = TokenBodySchema.parse(ctx.request.body);
      } catch (err) {
        return ctx.throw(400, err as Error);
      }

      await runInTransaction(async (conn) => {
        const [item] = await conn.query(sql`
          SELECT userId
            FROM trackingAccessToken
            JOIN trackingDevice ON (deviceId = trackingDevice.id)
            WHERE trackingAccessToken.id = ${ctx.params.id}
            FOR UPDATE
        `);

        if (!item) {
          ctx.throw(404, 'no such tracking access token');
        }

        if (!ctx.state.user!.isAdmin && item.userId !== ctx.state.user!.id) {
          ctx.throw(403);
        }

        const { timeFrom, timeTo, note, listingLabel } = body;

        await conn.query(sql`
            UPDATE trackingAccessToken SET
              note = ${note},
              timeFrom = ${timeFrom && new Date(timeFrom)},
              timeTo = ${timeTo && new Date(timeTo)},
              listingLabel = ${listingLabel}
              WHERE id = ${ctx.params.id}
          `);
      });

      ctx.status = 204;
    },
  );
}
