import Router from '@koa/router';
import { randomBytes } from 'node:crypto';
import sql from 'sql-template-tag';
import { authenticator } from '../../authenticator.js';
import { pool } from '../../database.js';

export function attachRovasTokenHandler(router: Router) {
  router.post('/rovasToken', authenticator(true), async (ctx) => {
    const rovasToken = randomBytes(32).toString('base64');

    await pool.query(
      sql`UPDATE user SET rovasToken = ${rovasToken} WHERE id = ${ctx.state.user.id}`,
    );

    ctx.body = { rovasToken };
  });
}
