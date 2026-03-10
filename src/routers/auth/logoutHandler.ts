import { RouterInstance } from '@koa/router';
import sql from 'sql-template-tag';
import { authenticator } from '../../authenticator.js';
import { pool } from '../../database.js';
import { AUTH_REQUIRED, registerPath } from '../../openapi.js';

export function attachLogoutHandler(router: RouterInstance) {
  registerPath('/auth/logout', {
    post: {
      security: AUTH_REQUIRED,
      responses: { 204: {}, 401: {} },
    },
  });

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
