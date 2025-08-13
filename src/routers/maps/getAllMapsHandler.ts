import Router from '@koa/router';
import sql from 'sql-template-tag';
import { authenticator } from '../../authenticator.js';
import { pool } from '../../database.js';
import { acceptValidator } from '../../requestValidators.js';
import { assertGuard } from 'typia';
import { Map } from './types.js';

export function attachGetAllMapsHandler(router: Router) {
  router.get(
    '/',
    acceptValidator('application/json'),
    authenticator(true),
    async (ctx) => {
      const user = ctx.state.user!;

      const items = await pool.query(sql`
        SELECT id, name, public, createdAt, modifiedAt, map.userId, GROUP_CONCAT(mapWriteAccess.userId) AS writers
          FROM map LEFT JOIN mapWriteAccess ON (mapWriteAccess.mapId = id)
          WHERE map.userId = ${user.id}
          GROUP BY id, name, public, createdAt, modifiedAt, map.userId
      `);

      assertGuard<Omit<Map, 'data'>[]>(items);

      ctx.body = items.map((item) => {
        const writers = item.writers?.split(',').map((s) => Number(s)) ?? [];

        return {
          id: item.id,
          createdAt: item.createdAt.toISOString(),
          modifiedAt: item.modifiedAt.toISOString(),
          name: item.name,
          userId: item.userId,
          public: !!item.public,
          writers: item.userId === user.id ? writers : undefined,
          canWrite: item.userId === user.id || writers.includes(user.id),
        };
      });
    },
  );
}
