import { RouterInstance } from '@koa/router';
import sql from 'sql-template-tag';
import z from 'zod';
import { authenticator } from '../../authenticator.js';
import { pool } from '../../database.js';
import { AUTH_REQUIRED, registerPath } from '../../openapi.js';
import { acceptValidator } from '../../requestValidators.js';
import { zDateToIso, zNullableDateToIso } from '../../types.js';

const TokenDetailSchema = z
  .strictObject({
    id: z.uint32(),
    userId: z.uint32(),
    token: z.string().nonempty(),
    createdAt: zDateToIso,
    timeFrom: zNullableDateToIso,
    timeTo: zNullableDateToIso,
    note: z.string().nullable(),
    listingLabel: z.string().nullable(),
  })
  .meta({ id: 'TokenDetail' });

export function attachGetTokenHandler(router: RouterInstance) {
  registerPath('/tracking/access-tokens/{id}', {
    get: {
      summary: 'Get a tracking access token by ID',
      tags: ['tracking'],
      security: AUTH_REQUIRED,
      requestParams: {
        path: z.object({
          id: z.uint32(),
        }),
      },
      responses: {
        200: { content: { 'application/json': { schema: TokenDetailSchema } } },
        403: {},
        404: { description: 'no such tracking access token' },
      },
    },
  });

  router.get(
    '/access-tokens/:id',
    acceptValidator('application/json'),
    authenticator(true),
    async (ctx) => {
      const [item] = TokenDetailSchema.array()
        .max(1)
        .parse(
          await pool.query(sql`
            SELECT trackingAccessToken.id, userId, trackingAccessToken.token, trackingAccessToken.createdAt, timeFrom, timeTo, note, listingLabel
              FROM trackingAccessToken
              JOIN trackingDevice ON (trackingAccessToken.deviceId = trackingDevice.id)
              WHERE trackingAccessToken.id = ${ctx.params.id}
          `),
        );

      if (!item) {
        ctx.throw(404, 'no such tracking access token');
      }

      if (!ctx.state.user?.isAdmin && ctx.state.user?.id !== item.userId) {
        ctx.throw(403);
      }

      ctx.body = item;
    },
  );
}
