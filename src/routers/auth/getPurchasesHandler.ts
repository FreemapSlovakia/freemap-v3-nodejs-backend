import { RouterInstance } from '@koa/router';
import sql from 'sql-template-tag';
import { authenticator } from '../../authenticator.js';
import { pool } from '../../database.js';

export function attachGetPurchasesHandler(router: RouterInstance) {
  router.get('/purchases', authenticator(true), async (ctx) => {
    ctx.body = await pool.query(
      sql`SELECT item, createdAt FROM purchase WHERE userId = ${ctx.state.user!.id}`,
    );
  });
}
