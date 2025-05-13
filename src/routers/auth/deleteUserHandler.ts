import Router from '@koa/router';
import { unlink } from 'node:fs/promises';
import sql from 'sql-template-tag';
import { authenticator } from '../../authenticator.js';
import { runInTransaction } from '../../database.js';
import { picturesDir } from '../gallery/constants.js';

export function attachDeleteUserHandler(router: Router) {
  router.delete(
    '/settings',
    authenticator(true),
    runInTransaction(),
    async (ctx) => {
      const conn = ctx.state.dbConn!;

      const rows = await conn.query(
        sql`SELECT pathname FROM picture WHERE userId = ${ctx.state.user!.id} FOR UPDATE`,
      );

      await Promise.all(
        rows.map((row: any) =>
          unlink(`${picturesDir}/${row.pathname}`).catch((err) => {
            ctx.log.error({ err }, 'Error deleting picture.');
          }),
        ),
      );

      await conn.query(sql`DELETE FROM user WHERE id = ${ctx.state.user!.id}`);

      ctx.status = 204;
    },
  );
}
