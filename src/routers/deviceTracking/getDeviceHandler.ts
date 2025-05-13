import Router from '@koa/router';
import sql from 'sql-template-tag';
import { authenticator } from '../../authenticator.js';
import { pool } from '../../database.js';
import { acceptValidator } from '../../requestValidators.js';

export function attachGetDeviceHandler(router: Router) {
  router.get(
    '/devices/:id',
    acceptValidator('application/json'),
    authenticator(true),
    async (ctx) => {
      const [item] = await pool.query(sql`
        SELECT id, name, token, createdAt, maxCount, maxAge, userId
          FROM trackingDevice
          WHERE id = ${ctx.params.id}
      `);

      if (!item) {
        ctx.throw(404, 'no such tracking device');
      }

      if (!ctx.state.user?.isAdmin && ctx.state.user?.id !== item.userId) {
        ctx.throw(403);
      }

      ctx.body = item;
    },
  );
}
