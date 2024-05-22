import Router from '@koa/router';
import sql from 'sql-template-tag';
import { pool } from '../../database';
import { acceptValidator } from '../../requestValidators';
import { authenticator } from '../../authenticator';

export function attachGetTokenHandler(router: Router) {
  router.get(
    '/access-tokens/:id',
    acceptValidator('application/json'),
    authenticator(true),
    async (ctx) => {
      const [item] = await pool.query(sql`
        SELECT trackingAccessToken.id, userId, trackingAccessToken.token, trackingAccessToken.createdAt, timeFrom, timeTo, note, listingLabel
          FROM trackingAccessToken
          JOIN trackingDevice ON (trackingAccessToken.deviceId = trackingDevice.id)
          WHERE trackingAccessToken.id = ${ctx.params.id}
      `);

      if (!item) {
        ctx.throw(404, 'no such tracking access token');
      }

      if (!ctx.state.user.isAdmin && ctx.state.user.id !== item.userId) {
        ctx.throw(403);
      }

      ctx.body = item;
    },
  );
}
