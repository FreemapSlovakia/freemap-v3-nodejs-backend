import { createHmac } from 'node:crypto';
import { RouterInstance } from '@koa/router';
import sql from 'sql-template-tag';
import z from 'zod';
import { runInTransaction } from '../../database.js';
import { getEnv } from './../../env.js';
import { registerPath } from '../../openapi.js';

const BodySchema = z.strictObject({
  token: z.string().nonempty(),
  email: z.email(),
  signature: z.string().nonempty(),
  amount_paid: z.union([z.number(), z.string()]).optional(),
  currency: z.string().nonempty().optional(),
});

export function attachPurchaseValidateHandler(router: RouterInstance) {
  registerPath('/auth/purchaseValidate', {
    post: {
      summary:
        'Payment provider webhook to validate and apply a completed purchase',
      tags: ['auth'],
      requestBody: { content: { 'application/json': { schema: BodySchema } } },
      responses: { 204: {}, 400: {}, 403: {} },
    },
  });

  router.post('/purchaseValidate', async (ctx) => {
    console.log(ctx.request.body);

    let body;

    try {
      body = BodySchema.parse(ctx.request.body);
    } catch (err) {
      return ctx.throw(400, err as Error);
    }

    const {
      token,
      email,
      signature,
      // amount_paid,
      // currency,
    } = body;

    if (
      createHmac('sha256', getEnv('PURCHASE_SECRET'))
        .update(token)
        .digest('hex') !== signature
    ) {
      ctx.throw(403, 'invalid signature');
    }

    await runInTransaction(async (conn) => {
      const [row] = await conn.query(
        sql`SELECT userId, item FROM purchaseToken WHERE token = ${token} AND expireAt > NOW() FOR UPDATE`,
      );

      if (!row) {
        ctx.throw(403, 'no such token');
      }

      const { userId, item } = row;

      await conn.query(
        sql`INSERT INTO purchase SET userId = ${userId}, item = ${item}, createdAt = NOW()`,
      );

      switch (item.type) {
        case 'premium':
          await conn.query(
            sql`UPDATE user
              SET premiumExpiration =
                CASE WHEN premiumExpiration IS NULL OR premiumExpiration < NOW()
                  THEN NOW()
                  ELSE premiumExpiration
                END + INTERVAL 1 YEAR,
                email = COALESCE(email, ${email})
              WHERE id = ${userId}`,
          );
          break;

        case 'credits':
          await conn.query(
            sql`UPDATE user SET credits = credits + ${item.amount}, email = COALESCE(email, ${email}) WHERE id = ${userId}`,
          );
          break;

        default:
          ctx.throw(
            new Error('invalid item type in purchase token: ' + item.type),
          );
      }

      await conn.query(sql`DELETE FROM purchaseToken WHERE token = ${token}`);
    });

    ctx.status = 204;
  });
}
