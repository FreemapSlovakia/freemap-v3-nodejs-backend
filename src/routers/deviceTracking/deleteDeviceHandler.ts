import Router from '@koa/router';
import sql from 'sql-template-tag';
import { authenticator } from '../../authenticator.js';
import { runInTransaction } from '../../database.js';
import { acceptValidator } from '../../requestValidators.js';

export function attachDeleteDeviceHandler(router: Router) {
  router.delete(
    '/devices/:id',
    acceptValidator('application/json'),
    authenticator(true),
    runInTransaction(),
    async (ctx) => {
      const conn = ctx.state.dbConn!;

      const [item] = await conn.query(
        sql`SELECT userId FROM trackingDevice WHERE id = ${ctx.params.id} FOR UPDATE`,
      );

      if (!item) {
        ctx.throw(404, 'no such tracking device');
      }

      if (!ctx.state.user?.isAdmin && item.userId !== ctx.state.user?.id) {
        ctx.throw(403);
      }

      await conn.query(
        sql`DELETE FROM trackingDevice WHERE id = ${ctx.params.id}`,
      );

      ctx.status = 204;
    },
  );
}
