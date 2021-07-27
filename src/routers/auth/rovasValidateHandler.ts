import { pool } from '../../database';
import Router from '@koa/router';
import { authenticator } from '../../authenticator';
import SQL from 'sql-template-strings';
import { getEnv } from './../../env';

export function attachRovasValidateHandler(router: Router) {
  router.post('/rovasValidate', authenticator(true /*, true*/), async (ctx) => {
    const { rovasToken, id } = ctx.state.user;

    const { signature } = ctx.request.body;

    const x = getEnv('ROVAS_VALIDITY_PREFIX') + encodeURIComponent(rovasToken);

    const { affectedRows } = await pool.query(
      SQL`UPDATE user SET lastPaymentAt = NOW(), rovasToken = NULL
        WHERE id = ${id} AND SHA2(${x}, 512) = ${signature}`,
    );

    ctx.status = affectedRows ? 204 : 404;
  });
}
