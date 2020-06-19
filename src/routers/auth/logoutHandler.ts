import Router from '@koa/router';
import { SQL } from 'sql-template-strings';
import { pool } from '../../database';
import { authenticator } from '../../authenticator';

export function attachLogoutHandler(router: Router) {
  router.post('/logout', authenticator(true), async (ctx) => {
    const { affectedRows } = await pool.query(
      SQL`DELETE FROM auth WHERE authToken = ${ctx.state.user.authToken}`,
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
