import Router from '@koa/router';
import { pool, runInTransaction } from '../../database';
import { authenticator } from '../../authenticator';
import SQL from 'sql-template-strings';
import { promises as fs } from 'fs';
import { picturesDir } from '../gallery/constants';

export function attachDeleteUserHandler(router: Router) {
  router.delete(
    '/settings',
    authenticator(true, false),
    runInTransaction(),
    async (ctx) => {
      const conn = ctx.state.dbConn;

      const rows = await conn.query(
        SQL`SELECT pathname FROM picture WHERE userId = ${ctx.state.user.id} FOR UPDATE`,
      );

      await Promise.all(
        rows.map((row: any) =>
          fs.unlink(`${picturesDir}/${row.pathname}`).catch((err) => {
            ctx.log.error({ err }, 'Error deleting picture.');
          }),
        ),
      );

      await conn.query(SQL`DELETE FROM user WHERE id = ${ctx.state.user.id}`);

      ctx.status = 204;
    },
  );
}
