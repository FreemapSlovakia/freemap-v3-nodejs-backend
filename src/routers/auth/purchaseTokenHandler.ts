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

      const { item } = ctx.body;

      await pool.query(
        sql`INSERT INTO purchase_token SET
        userId = ${ctx.state.user!.id},
        createdAt = NOW(),
        token = ${token},
        expireAt = ${expireAt},
        item = ${JSON.stringify(item)}`,
      );

      const expiration = Math.floor(expireAt.getTime() / 1000);

      // https://dev.rovas.app/rewpro?paytype=project&recipient=35384
      const paymentUrl = new URL(getEnv('PURCHASE_URL_PREFIX')!);

      const { searchParams } = paymentUrl;

      searchParams.set('token', token);

      // TODO to env variable
      searchParams.set(
        'callbackurl',
        'https://www.freemap.sk/purchaseCallback.html',
      );

      searchParams.set('expiration', String(expiration));

      // TODO translate texts by language
      switch (item.type) {
        case 'premium':
          searchParams.set('price_eur', '5');
          searchParams.set('name', 'Freemap.sk premium access');
          searchParams.set(
            'description',
            'Premium access to Freemap.sk for 1 year',
          );
          break;
        case 'credits':
          searchParams.set('price_eur', String(item.amount)); // let the exchange rate is 1
          searchParams.set('name', 'Freemap.sk credits');
          searchParams.set(
            'description',
            `Purchase of ${item.amount} Freemap.sk credits`,
          );
          break;
        default:
          ctx.throw(
            new Error('invalid item type in purchase token: ' + item.type),
          );
      }

      const paymentUrlString = paymentUrl.toString();

      ctx.body = {
        paymentUrl:
          paymentUrlString +
          '&signature=' +
          createHmac('sha256', getEnv('PURCHASE_SECRET')!)
            .update(paymentUrlString)
            .digest('hex'),
      };
    },
  );
}
