import Router from '@koa/router';
import sql from 'sql-template-tag';
import { authenticator } from '../../authenticator.js';
import { pool } from '../../database.js';

export function attachLogoutHandler(router: Router) {
  router.post('/logout', authenticator(true), async (ctx) => {
    const { affectedRows } = await pool.query(
      sql`DELETE FROM auth WHERE authToken = ${ctx.state.user!.authToken}`,
    );

    if (!affectedRows) {
      ctx.set(
        'WWW-Authenticate',
        'Bearer realm="freemap"; error="invalid token"',
      );

      ctx.throw(401, 'invalid token');
    }

    ctx.status = 204;
  });
}
