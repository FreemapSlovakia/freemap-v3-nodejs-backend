import { RouterInstance } from '@koa/router';
import sql from 'sql-template-tag';
import { authenticator } from '../../authenticator.js';
import { pool } from '../../database.js';
import { acceptValidator } from '../../requestValidators.js';

export function attachGetAllTokensHandler(router: RouterInstance) {
  router.get(
    '/devices/:id/access-tokens',
    acceptValidator('application/json'),
    authenticator(true),
    async (ctx) => {
      const [device] = await pool.query(
        sql`SELECT userId FROM trackingDevice WHERE id = ${ctx.params.id}`,
      );

      if (!device) {
        ctx.throw(404, 'no such tracking device');
      }

      if (!ctx.state.user!.isAdmin && ctx.state.user!.id !== device.userId) {
        ctx.throw(403);
      }

      ctx.body = await pool.query(sql`
        SELECT id, token, createdAt, timeFrom, timeTo, note, listingLabel
          FROM trackingAccessToken WHERE deviceId = ${ctx.params.id}
      `);
    },
  );
}
