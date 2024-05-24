import Router from '@koa/router';
import sql from 'sql-template-tag';
import { authenticator } from '../../authenticator.js';
import { pool } from '../../database.js';
import { getEnv } from './../../env.js';

export function attachRovasValidateHandler(router: Router) {
  router.post('/rovasValidate', authenticator(true), async (ctx) => {
    const { rovasToken, id } = ctx.state.user;

    const { signature } = ctx.request.body;

    const x = getEnv('ROVAS_VALIDITY_PREFIX') + encodeURIComponent(rovasToken);

    const { affectedRows } = await pool.query(
      sql`UPDATE user SET lastPaymentAt = NOW(), rovasToken = NULL
        WHERE id = ${id} AND SHA2(${x}, 512) = ${signature}`,
    );

    ctx.status = affectedRows ? 204 : 404;
  });
}
