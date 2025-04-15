import Router from '@koa/router';
import { createHmac } from 'node:crypto';
import sql from 'sql-template-tag';
import { pool, runInTransaction } from '../../database.js';
import { getEnv } from './../../env.js';

export function attachPurchaseValidateHandler(router: Router) {
  router.post('/purchaseValidate', runInTransaction(), async (ctx) => {
    const { token, signature } = ctx.request.body;

    if (
      createHmac('sha256', getEnv('ROVAS_VALIDITY_PREFIX'))
        .update(token)
        .digest('hex') !== signature
    ) {
      ctx.status = 403;
      ctx.body = 'invalid signature';

      return;
    }

    const [row] = await pool.query(
      sql`SELECT userId FROM purchase_token WHERE token = ${token} AND TIMESTAMPDIFF(MINUTE, createdAt, now()) < 60 FOR UPDATE`,
    );

    if (!row) {
      ctx.status = 403;
      ctx.body = 'no such token';

      return;
    }

    await pool.query(
      sql`INSERT INTO purchase (userId, article, createdAt) VALUES (${row.userId}, 'rovas-default', now())`,
    );

    await pool.query(sql`DELETE FROM purchase_token WHERE token = ${token}`);

    ctx.status = 204;
  });
}
