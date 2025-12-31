import { RouterInstance } from '@koa/router';
import sql from 'sql-template-tag';
import { authenticator } from '../../authenticator.js';
import { pool } from '../../database.js';
import { acceptValidator } from '../../requestValidators.js';

export function attachGetAllDevicesHandler(router: RouterInstance) {
  router.get(
    '/devices',
    acceptValidator('application/json'),
    authenticator(true),
    async (ctx) => {
      ctx.body = await pool.query(sql`
        SELECT id, name, token, createdAt, maxCount, maxAge, userId
          FROM trackingDevice
          WHERE userId = ${ctx.state.user!.id}
      `);
    },
  );
}
