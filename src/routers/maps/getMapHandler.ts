import Router from '@koa/router';
import sql from 'sql-template-tag';
import { authenticator } from '../../authenticator.js';
import { pool } from '../../database.js';
import { acceptValidator } from '../../requestValidators.js';
import { assertGuard } from 'typia';
import { Map } from './types.js';

export function attachGetMapHandler(router: Router) {
  router.get(
    '/:id',
    acceptValidator('application/json'),
    authenticator(false),
    async (ctx) => {
      const [item] = await pool.query(sql`
        SELECT id, name, public, data, createdAt, modifiedAt, map.userId, GROUP_CONCAT(mapWriteAccess.userId) AS writers
          FROM map LEFT JOIN mapWriteAccess ON (mapWriteAccess.mapId = id)
          WHERE id = ${ctx.params.id}
          GROUP BY id, name, public, data, createdAt, map.userId
      `);

      if (!item) {
        ctx.throw(404, 'no such map');
      }

      assertGuard<Map>(item);

      const { user } = ctx.state;

      if (
        !item.public &&
        (!user || (!user.isAdmin && user.id !== item.userId))
      ) {
        ctx.throw(403);
      }

      const writers =
        item.writers?.split(',').map((s: string) => Number(s)) ?? [];

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
