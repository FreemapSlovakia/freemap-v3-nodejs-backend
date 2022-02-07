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
        SELECT id, name, public, data, createdAt, map.userId, GROUP_CONCAT(mapWriteAccess.userId) AS writers
          FROM map LEFT JOIN mapWriteAccess ON (mapWriteAccess.mapId = id)
          WHERE id = ${ctx.params.id}
          GROUP BY id, name, public, data, createdAt, map.userId
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

      if (ctx.state.user && item.userId === ctx.state.user.id) {
        item.public = !!item.public;

        item.writers =
          item.writers?.split(',').map((s: any) => Number(s)) ?? [];
      }

      item.canWrite =
        !!ctx.state.user &&
        (item.userId === ctx.state.user.id ||
          (item.writers ?? []).includes(ctx.state.user.id));

      ctx.body = item;
    },
  );
}
