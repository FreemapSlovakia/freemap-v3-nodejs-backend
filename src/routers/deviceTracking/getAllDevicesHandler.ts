import Router from '@koa/router';
import { SQL } from 'sql-template-strings';
import { pool } from '../../database';
import { acceptValidator } from '../../requestValidators';
import { authenticator } from '../../authenticator';

export function attachGetAllDevicesHandler(router: Router) {
  router.get(
    '/devices',
    acceptValidator('application/json'),
    authenticator(true),
    async ctx => {
      ctx.body = await pool.query(SQL`
        SELECT id, name, token, createdAt, maxCount, maxAge, userId
          FROM trackingDevice
          WHERE userId = ${ctx.state.user.id}
      `);
    },
  );
}
