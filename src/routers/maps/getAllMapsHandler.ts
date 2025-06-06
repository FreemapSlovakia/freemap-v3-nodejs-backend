import Router from '@koa/router';
import sql from 'sql-template-tag';
import { authenticator } from '../../authenticator.js';
import { pool } from '../../database.js';
import { acceptValidator } from '../../requestValidators.js';

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

      ctx.body = items.map((item: any) => {
        const writers =
          item.writers?.split(',').map((s: any) => Number(s)) ?? [];

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
