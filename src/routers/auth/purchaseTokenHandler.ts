import Router from '@koa/router';
import { randomBytes } from 'node:crypto';
import sql from 'sql-template-tag';
import { authenticator } from '../../authenticator.js';
import { pool } from '../../database.js';

export function attachPurchaseTokenHandler(router: Router) {
  router.post('/purchaseToken', authenticator(true), async (ctx) => {
    const token = randomBytes(32).toString('hex');

    await pool.query(
      sql`INSERT INTO purchase_token (userId, createdAt, token) VALUES (${ctx.state.user.id}, now(), ${token})`,
    );

    ctx.body = { token };
  });
}
