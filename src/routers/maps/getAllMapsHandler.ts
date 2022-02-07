import Router from '@koa/router';
import { SQL } from 'sql-template-strings';
import { pool } from '../../database';
import { acceptValidator } from '../../requestValidators';
import { authenticator } from '../../authenticator';

export function attachGetAllMapsHandler(router: Router) {
  router.get(
    '/',
    acceptValidator('application/json'),
    authenticator(true),
    async (ctx) => {
      ctx.body = await pool.query(SQL`
        SELECT id, name, public, createdAt, modifiedAt, map.userId, GROUP_CONCAT(mapWriteAccess.userId) AS writers
          FROM map LEFT JOIN mapWriteAccess ON (mapWriteAccess.mapId = id)
          WHERE map.userId = ${ctx.state.user.id}
          GROUP BY id, name, public, createdAt, modifiedAt, map.userId
      `);

      for (const item of ctx.body) {
        item.public = !!item.public;

        item.createdAt = item.createdAt.toISOString();

        item.modifiedAt = item.modifiedAt.toISOString();

        item.writers =
          item.writers?.split(',').map((s: any) => Number(s)) ?? [];

        item.canWrite = true;
      }
    },
  );
}
