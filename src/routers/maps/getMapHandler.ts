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
        SELECT id, name, public, data, createdAt, modifiedAt, map.userId, GROUP_CONCAT(mapWriteAccess.userId) AS writers
          FROM map LEFT JOIN mapWriteAccess ON (mapWriteAccess.mapId = id)
          WHERE id = ${ctx.params.id}
          GROUP BY id, name, public, data, createdAt, map.userId
      `);

      if (!item) {
        ctx.throw(404, 'no such map');
      }

      const { user } = ctx.state;

      if (
        !item.public &&
        (!user || (!user.isAdmin && user.id !== item.userId))
      ) {
        ctx.throw(403);
      }

      const writers = item.writers?.split(',').map((s: any) => Number(s)) ?? [];

      ctx.body = {
        meta: {
          id: item.id,
          createdAt: item.createdAt.toISOString(),
          modifiedAt: item.modifiedAt.toISOString(),
          name: item.name,
          userId: item.userId,
          public: !!item.public,
          writers: item.userId === user?.id ? writers : undefined,
          canWrite: !!(
            user &&
            (item.userId === user.id || writers.includes(user.id))
          ),
        },
        data: JSON.parse(item.data),
      };
    },
  );
}
