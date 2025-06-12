import Router from '@koa/router';
import { createHmac, randomBytes } from 'node:crypto';
import sql from 'sql-template-tag';
import { authenticator } from '../../authenticator.js';
import { pool } from '../../database.js';
import { getEnv } from '../../env.js';
import { bodySchemaValidator } from '../../requestValidators.js';

export function attachPurchaseTokenHandler(router: Router) {
  router.post(
    '/purchaseToken',
    authenticator(true),
    bodySchemaValidator({
      oneOf: [
        {
          type: 'object',
          required: ['type'],
          additionalProperties: false,
          properties: {
            type: { const: 'premium' },
          },
        },
        {
          type: 'object',
          required: ['type'],
          additionalProperties: false,
          properties: {
            type: { const: 'credits' },
            amount: { type: 'number' },
          },
        },
      ],
    }),
    async (ctx) => {
      const token = randomBytes(32).toString('hex');

      const expireAt = new Date(Date.now() + 3_600_000); // 1 hour

      const item = ctx.request.body;

      await pool.query(
        sql`INSERT INTO purchaseToken SET
        userId = ${ctx.state.user!.id},
        createdAt = NOW(),
        token = ${token},
        expireAt = ${expireAt},
        item = ${JSON.stringify(item)}`,
      );

      const expiration = Math.floor(expireAt.getTime() / 1000);

      // https://dev.rovas.app/rewpro?paytype=project&recipient=35384
      const paymentUrl = new URL(getEnv('PURCHASE_URL_PREFIX'));

      const { searchParams } = paymentUrl;

      searchParams.set('token', token);

      searchParams.set('callbackurl', getEnv('PURCHASE_CALLBACK_URL'));

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
          createHmac('sha256', getEnv('PURCHASE_SECRET'))
            .update(paymentUrlString)
            .digest('hex'),
      };
    },
  );
}
