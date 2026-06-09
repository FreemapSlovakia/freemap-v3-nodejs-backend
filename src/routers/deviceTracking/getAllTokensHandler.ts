import { RouterInstance } from '@koa/router';
import sql from 'sql-template-tag';
import z from 'zod';
import { authenticator } from '../../authenticator.js';
import { pool } from '../../database.js';
import { AUTH_REQUIRED, registerPath } from '../../openapi.js';
import { acceptValidator } from '../../requestValidators.js';
import { isOwnerOrRole } from '../../roles.js';
import { zDateToIso, zNullableDateToIso } from '../../types.js';

const AccessTokensSchema = z
  .strictObject({
    id: z.uint32(),
    token: z.string().nonempty(),
    createdAt: zDateToIso,
    timeFrom: zNullableDateToIso,
    timeTo: zNullableDateToIso,
    listingLabel: z.string().nullable(),
    note: z.string().nullable(),
  })
  .array();

export function attachGetAllTokensHandler(router: RouterInstance) {
  registerPath('/tracking/devices/{id}/access-tokens', {
    get: {
      summary: 'List access tokens for a tracking device',
      tags: ['tracking'],
      security: AUTH_REQUIRED,
      requestParams: {
        path: z.object({
          id: z.uint32(),
        }),
      },
      responses: {
        200: {
          content: { 'application/json': { schema: AccessTokensSchema } },
        },
        403: {},
        404: { description: 'no such tracking device' },
      },
    },
  });

  router.get(
    '/devices/:id/access-tokens',
    acceptValidator('application/json'),
    authenticator(true),
    async (ctx) => {
      const [device] = await pool.query<{ userId: number }[]>(
        sql`SELECT userId FROM trackingDevice WHERE id = ${ctx.params.id}`,
      );

      if (!device) {
        ctx.throw(404, 'no such tracking device');
      }

      if (!isOwnerOrRole(ctx.state.user, device.userId, 'trackingManager')) {
        ctx.throw(403);
      }

      ctx.body = AccessTokensSchema.parse(
        await pool.query<unknown>(sql`
            SELECT id, token, createdAt, timeFrom, timeTo, note, listingLabel
            FROM trackingAccessToken
            WHERE deviceId = ${ctx.params.id}
        `),
      );
    },
  );
}
