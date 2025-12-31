import sql from 'sql-template-tag';
import { authenticator } from '../../authenticator.js';
import { runInTransaction } from '../../database.js';
import { acceptValidator } from '../../requestValidators.js';
import { RouterInstance } from '@koa/router';

export function attachDeleteMapHandler(router: RouterInstance) {
  router.delete(
    '/:id',
    acceptValidator('application/json'),
    authenticator(true),
    async (ctx) => {
      await runInTransaction(async (conn) => {
        const [item] = await conn.query(
          sql`SELECT userId FROM map WHERE id = ${ctx.params.id} FOR UPDATE`,
        );

        if (!item) {
          ctx.throw(404, 'no such map');
        }

        if (!ctx.state.user!.isAdmin && item.userId !== ctx.state.user!.id) {
          ctx.throw(403);
        }

        await conn.query(sql`DELETE FROM map WHERE id = ${ctx.params.id}`);
      });

      ctx.status = 204;
    },
  );
}
