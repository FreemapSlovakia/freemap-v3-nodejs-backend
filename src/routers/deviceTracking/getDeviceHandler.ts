import Router from '@koa/router';
import { SQL } from 'sql-template-strings';
import { pool } from '../../database';
import { acceptValidator } from '../../requestValidators';
import { authenticator } from '../../authenticator';

export function attachGetDeviceHandler(router: Router) {
  router.get(
    '/devices/:id',
    acceptValidator('application/json'),
    authenticator(true),
    async (ctx) => {
      const [item] = await pool.query(SQL`
        SELECT id, name, token, createdAt, maxCount, maxAge, userId
          FROM trackingDevice
          WHERE id = ${ctx.params.id}
      `);

      if (!item) {
        ctx.throw(404, 'no such tracking device');
      }

      if (!ctx.state.user.isAdmin && ctx.state.user.id !== item.userId) {
        ctx.throw(403);
      }

      ctx.body = item;
    },
  );
}
