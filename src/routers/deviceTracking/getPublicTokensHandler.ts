import { RouterInstance } from '@koa/router';
import { pool } from '../../database.js';
import { acceptValidator } from '../../requestValidators.js';

export function attachGetPublicTokensHandler(router: RouterInstance) {
  router.get(
    '/access-tokens',
    acceptValidator('application/json'),
    async (ctx) => {
      ctx.body = await pool.query(
        `SELECT id, token, createdAt, timeFrom, timeTo, listingLabel
          FROM trackingAccessToken
          WHERE listingLabel IS NOT NULL`,
      );
    },
  );
}
