import Router from '@koa/router';
import sql from 'sql-template-tag';
import { pool } from '../../database.js';
import { acceptValidator } from '../../requestValidators.js';
import { authenticator } from '../../authenticator.js';

export function attachGetAllDevicesHandler(router: Router) {
  router.get(
    '/devices',
    acceptValidator('application/json'),
    authenticator(true),
    async (ctx) => {
      ctx.body = await pool.query(sql`
        SELECT id, name, token, createdAt, maxCount, maxAge, userId
          FROM trackingDevice
          WHERE userId = ${ctx.state.user.id}
      `);
    },
  );
}
