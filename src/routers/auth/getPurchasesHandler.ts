import { RouterInstance } from '@koa/router';
import sql from 'sql-template-tag';
import z from 'zod';
import { authenticator } from '../../authenticator.js';
import { pool } from '../../database.js';
import { AUTH_REQUIRED, registerPath } from '../../openapi.js';
import { zDateToIso } from '../../types.js';

const ResponseSchema = z.array(
  z.strictObject({
    item: z.discriminatedUnion('type', [
      z.strictObject({ type: z.literal('premium') }),
      z.strictObject({
        type: z.literal('credits'),
        amount: z.number().positive(),
      }),
    ]),
    createdAt: zDateToIso,
  }),
);

export function attachGetPurchasesHandler(router: RouterInstance) {
  registerPath('/auth/purchases', {
    get: {
      summary: "List the authenticated user's purchases",
      tags: ['auth'],
      security: AUTH_REQUIRED,
      responses: {
        200: { content: { 'application/json': { schema: ResponseSchema } } },
        401: {},
      },
    },
  });

  router.get('/purchases', authenticator(true), async (ctx) => {
    ctx.body = ResponseSchema.parse(
      await pool.query(
        sql`SELECT item, createdAt FROM purchase WHERE userId = ${ctx.state.user!.id}`,
      ),
    );
  });
}
