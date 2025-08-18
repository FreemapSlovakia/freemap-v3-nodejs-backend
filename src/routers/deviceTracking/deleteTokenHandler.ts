import Router from '@koa/router';
import sql from 'sql-template-tag';
import { authenticator } from '../../authenticator.js';
import { runInTransaction } from '../../database.js';
import { acceptValidator } from '../../requestValidators.js';

export function attachDeleteTokenHandler(router: Router) {
  router.delete(
    '/access-tokens/:id',
    acceptValidator('application/json'),
    authenticator(true),
    async (ctx) => {
      await runInTransaction(async (conn) => {
        const [item] = await conn.query(sql`
          SELECT userId FROM trackingAccessToken
            JOIN trackingDevice ON (deviceId = trackingDevice.id)
            WHERE trackingAccessToken.id = ${ctx.params.id} FOR UPDATE
        `);

        if (!item) {
          ctx.throw(404, 'no such tracking access token');
        }

        if (!ctx.state.user!.isAdmin && item.userId !== ctx.state.user!.id) {
          ctx.throw(403);
        }

        await conn.query(
          sql`DELETE FROM trackingAccessToken WHERE id = ${ctx.params.id}`,
        );
      });

      ctx.status = 204;
    },
  );
}
