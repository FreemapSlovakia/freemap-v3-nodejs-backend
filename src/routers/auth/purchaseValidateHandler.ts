import Router from '@koa/router';
import { createHmac } from 'node:crypto';
import sql from 'sql-template-tag';
import { pool, runInTransaction } from '../../database.js';
import { getEnv } from './../../env.js';

export function attachPurchaseValidateHandler(router: Router) {
  router.post('/purchaseValidate', runInTransaction(), async (ctx) => {
    const { token, signature } = ctx.request.body;

    if (
      createHmac('sha256', getEnv('PURCHASE_SECRET'))
        .update(token)
        .digest('hex') !== signature
    ) {
      ctx.status = 403;
      ctx.body = 'invalid signature';

      return;
    }

    const [row] = await pool.query(
      sql`SELECT userId, item FROM purchaseToken WHERE token = ${token} AND expireAt > NOW() FOR UPDATE`,
    );

    if (!row) {
      ctx.status = 403;
      ctx.body = 'no such token';

      return;
    }

    const { userId, item } = row;

    await pool.query(
      sql`INSERT INTO purchase SET userId = ${userId}, item = ${item}, createdAt = NOW()`,
    );

    switch (item.type) {
      case 'premium':
        await pool.query(
          sql`UPDATE user
            SET premiumExpiration =
              CASE WHEN premiumExpiration IS NULL OR premiumExpiration < NOW()
                THEN NOW()
                ELSE premiumExpiration
              END + INTERVAL 1 YEAR
            WHERE id = ${userId}`,
        );
        break;

      case 'credits':
        await pool.query(
          sql`UPDATE user SET credits = credits + ${item.amount} WHERE id = ${userId}`,
        );
        break;

      default:
        ctx.throw(
          new Error('invalid item type in purchase token: ' + item.type),
        );
    }

    await pool.query(sql`DELETE FROM purchaseToken WHERE token = ${token}`);

    ctx.status = 204;
  });
}
