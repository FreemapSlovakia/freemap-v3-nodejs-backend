import Router from '@koa/router';
import { SQL } from 'sql-template-strings';
import { pool } from '../../database';
import { acceptValidator } from '../../requestValidators';
import { authenticator } from '../../authenticator';

export function attachGetMapHandler(router: Router) {
  router.get(
    '/:id',
    acceptValidator('application/json'),
    authenticator(false),
    async (ctx) => {
      const [item] = await pool.query(SQL`
        SELECT id, name, public, data, createdAt, userId
          FROM map
          WHERE id = ${ctx.params.id}
      `);

      if (!item) {
        ctx.throw(404, 'no such map');
      }

      if (
        !item.public &&
        (!ctx.state.user ||
          (!ctx.state.user.isAdmin && ctx.state.user.id !== item.userId))
      ) {
        ctx.throw(403);
      }

      item.data = JSON.parse(item.data);

      item.public = !!item.public;

      ctx.body = item;
    },
  );
}
