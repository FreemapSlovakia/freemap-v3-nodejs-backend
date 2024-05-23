import Router from '@koa/router';
import sql from 'sql-template-tag';
import { runInTransaction } from '../../database.js';
import { acceptValidator } from '../../requestValidators.js';
import { authenticator } from '../../authenticator.js';

export function attachDeleteMapHandler(router: Router) {
  router.delete(
    '/:id',
    acceptValidator('application/json'),
    authenticator(true),
    runInTransaction(),
    async (ctx) => {
      const conn = ctx.state.dbConn;

      const [item] = await conn.query(
        sql`SELECT userId FROM map WHERE id = ${ctx.params.id} FOR UPDATE`,
      );

      if (!item) {
        ctx.throw(404, 'no such map');
      }

      if (!ctx.state.user.isAdmin && item.userId !== ctx.state.user.id) {
        ctx.throw(403);
      }

      await conn.query(sql`DELETE FROM map WHERE id = ${ctx.params.id}`);

      ctx.status = 204;
    },
  );
}
