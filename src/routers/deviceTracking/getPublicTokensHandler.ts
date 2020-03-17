import Router from '@koa/router';
import { pool } from '../../database';
import { acceptValidator } from '../../requestValidators';

export function attachGetPublicTokensHandler(router: Router) {
  router.get(
    '/access-tokens',
    acceptValidator('application/json'),
    async ctx => {
      ctx.body = await pool.query(
        `SELECT id, token, createdAt, timeFrom, timeTo, listingLabel
          FROM trackingAccessToken
          WHERE listingLabel IS NOT NULL`,
      );
    },
  );
}
