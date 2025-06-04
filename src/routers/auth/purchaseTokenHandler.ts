import Router from '@koa/router';
import { createHmac, randomBytes } from 'node:crypto';
import sql from 'sql-template-tag';
import { getEnv } from 'src/env.js';
import { bodySchemaValidator } from 'src/requestValidators.js';
import { authenticator } from '../../authenticator.js';
import { pool } from '../../database.js';

export function attachPurchaseTokenHandler(router: Router) {
  router.post(
    '/purchaseToken',
    authenticator(true),
    bodySchemaValidator({
      type: 'object',
      properties: {
        item: {
          type: 'object',
          required: ['type'],
          oneOf: [
            {
              properties: {
                type: { const: 'premium' },
              },
            },
            {
              properties: {
                type: { const: 'credits' },
                amount: { type: 'number' },
              },
            },
          ],
        },
      },
      required: ['item'],
      additionalProperties: false,
    }),
    async (ctx) => {
      const token = randomBytes(32).toString('hex');

      const expireAt = new Date(Date.now() + 3_600_000); // 1 hour

      await pool.query(
        sql`INSERT INTO purchase_token SET
        userId = ${ctx.state.user!.id},
        createdAt = NOW(),
        token = ${token},
        expireAt = ${expireAt},
        item = ${JSON.stringify(ctx.body.item)}`,
      );

      const expiration = Math.floor(expireAt.getTime() / 1000);

      const paymentUrl =
        // 'https://dev.rovas.app/rewpro?paytype=project&recipient=35384'
        getEnv('PURCHASE_URL_PREFIX')! +
        '&token=' +
        encodeURIComponent(token) +
        '&callbackurl=' +
        // TODO to env variable
        encodeURIComponent('https://www.freemap.sk/purchaseCallback.html') +
        '&expiration=' +
        expiration;

      ctx.body = {
        paymentUrl:
          paymentUrl +
          '&signature=' +
          createHmac('sha256', getEnv('PURCHASE_SECRET')!)
            .update(paymentUrl)
            .digest('hex'),
      };
    },
  );
}
