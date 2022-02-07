import Router from '@koa/router';
import { SQL } from 'sql-template-strings';
import { runInTransaction } from '../../database';
import { acceptValidator } from '../../requestValidators';
import { authenticator } from '../../authenticator';

export function attachDeleteMapHandler(router: Router) {
  router.delete(
    '/:id',
    acceptValidator('application/json'),
    authenticator(true),
    runInTransaction(),
    async (ctx) => {
      const conn = ctx.state.dbConn;

      const [item] = await conn.query(
        SQL`SELECT userId FROM map WHERE id = ${ctx.params.id} FOR UPDATE`,
      );

      if (!item) {
        ctx.throw(404, 'no such map');
      }

      if (!ctx.state.user.isAdmin && item.userId !== ctx.state.user.id) {
        ctx.throw(403);
      }

      await conn.query(SQL`DELETE FROM map WHERE id = ${ctx.params.id}`);

      ctx.status = 204;
    },
  );
}
