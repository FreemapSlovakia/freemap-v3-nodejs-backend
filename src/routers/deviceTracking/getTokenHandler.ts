import Router from '@koa/router';
import { SQL } from 'sql-template-strings';
import { pool } from '../../database';
import { acceptValidator } from '../../requestValidators';
import { authenticator } from '../../authenticator';

export function attachGetTokenHandler(router: Router) {
  router.get(
    '/access-tokens/:id',
    acceptValidator('application/json'),
    authenticator(true),
    async ctx => {
      const [item] = await pool.query(SQL`
        SELECT id, token, createdAt, timeFrom, timeTo, note, listingLabel
          FROM trackingAccessToken
          JOIN trackingDevice ON (trackingAccessToken.deviceId = trackingDevice.id)
          WHERE id = ${ctx.params.id}
      `);

      if (!item) {
        ctx.throw(404);
      }

      if (!ctx.state.user.isAdmin && ctx.state.user.id !== item.userId) {
        ctx.throw(403);
      }

      ctx.body = item;
    },
  );
}
