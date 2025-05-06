import Router from '@koa/router';
import { randomBytes } from 'node:crypto';
import sql from 'sql-template-tag';
import { authenticator } from '../../authenticator.js';
import { pool } from '../../database.js';

export function attachPurchaseTokenHandler(router: Router) {
  router.post('/purchaseToken', authenticator(true), async (ctx) => {
    const token = randomBytes(32).toString('hex');

    const expiration = new Date(Date.now() + 3_600_000); // 1 hour

    await pool.query(
      sql`INSERT INTO purchase_token (userId, createdAt, token, expireAt) VALUES (${ctx.state.user.id}, NOW(), ${token}, ${expiration})`,
    );

    ctx.body = { token, expiration: Math.floor(expiration.getTime() / 1000) };
  });
}
