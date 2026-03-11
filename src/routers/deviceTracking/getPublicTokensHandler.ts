import { RouterInstance } from '@koa/router';
import sql from 'sql-template-tag';
import z from 'zod';
import { pool } from '../../database.js';
import { registerPath } from '../../openapi.js'; // no auth
import { acceptValidator } from '../../requestValidators.js';
import { zDateToIso, zNullableDateToIso } from '../../types.js';

const AccessTokensSchema = z
  .strictObject({
    id: z.uint32(),
    token: z.string(),
    createdAt: zDateToIso,
    timeFrom: zNullableDateToIso,
    timeTo: zNullableDateToIso,
    listingLabel: z.string().nullable(),
  })
  .array();

export function attachGetPublicTokensHandler(router: RouterInstance) {
  registerPath('/tracking/access-tokens', {
    get: {
      summary: 'List publicly listed tracking access tokens',
      tags: ['tracking'],
      responses: {
        200: {
          content: { 'application/json': { schema: AccessTokensSchema } },
        },
      },
    },
  });

  router.get(
    '/access-tokens',
    acceptValidator('application/json'),
    async (ctx) => {
      ctx.body = AccessTokensSchema.parse(
        await pool.query(
          sql`SELECT id, token, createdAt, timeFrom, timeTo, listingLabel
          FROM trackingAccessToken
          WHERE listingLabel IS NOT NULL`,
        ),
      );
    },
  );
}
