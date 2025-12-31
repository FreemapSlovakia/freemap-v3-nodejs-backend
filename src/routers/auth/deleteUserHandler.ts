import { RouterInstance } from '@koa/router';
import { unlink } from 'node:fs/promises';
import sql from 'sql-template-tag';
import { authenticator } from '../../authenticator.js';
import { runInTransaction } from '../../database.js';
import { appLogger } from '../../logger.js';
import { picturesDir } from '../gallery/constants.js';

export function attachDeleteUserHandler(router: RouterInstance) {
  router.delete('/settings', authenticator(true), async (ctx) => {
    const logger = appLogger.child({
      module: 'deleteUser',
      reqId: ctx.reqId,
    });

    await runInTransaction(async (conn) => {
      const rows = await conn.query(
        sql`SELECT pathname FROM picture WHERE userId = ${ctx.state.user!.id} FOR UPDATE`,
      );

      await Promise.all(
        rows.map((row: { pathname: string }) =>
          unlink(`${picturesDir}/${row.pathname}`).catch((err) => {
            logger.error({ err }, 'Error deleting picture.');
          }),
        ),
      );

      await conn.query(sql`DELETE FROM user WHERE id = ${ctx.state.user!.id}`);
    });

    ctx.status = 204;
  });
}
