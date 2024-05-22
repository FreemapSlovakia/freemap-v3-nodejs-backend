import { pool } from '../../database';
import Router from '@koa/router';
import { authenticator } from '../../authenticator';
import sql from 'sql-template-tag';
import { randomBytes } from 'crypto';

export function attachRovasTokenHandler(router: Router) {
  router.post('/rovasToken', authenticator(true), async (ctx) => {
    const rovasToken = randomBytes(32).toString('base64');

    await pool.query(
      sql`UPDATE user SET rovasToken = ${rovasToken} WHERE id = ${ctx.state.user.id}`,
    );

    ctx.body = { rovasToken };
  });
}
