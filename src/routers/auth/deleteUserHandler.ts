import { unlink } from 'node:fs/promises';
import type { RouterInstance } from '@koa/router';
import sql from 'sql-template-tag';
import { authenticator } from '../../authenticator.js';
import { runInTransaction } from '../../database.js';
import { appLogger } from '../../logger.js';
import { AUTH_REQUIRED, registerPath } from '../../openapi.js';
import { revokeOsmTokenLater } from '../../osm.js';
import { picturesDir } from '../gallery/constants.js';

export function attachDeleteUserHandler(router: RouterInstance) {
  registerPath('/auth/settings', {
    delete: {
      summary: "Delete the authenticated user's account",
      tags: ['auth'],
      security: AUTH_REQUIRED,
      responses: { 204: {}, 401: {} },
    },
  });

  router.delete('/settings', authenticator(true), async (ctx) => {
    const logger = appLogger.child({
      module: 'deleteUser',
      reqId: ctx.reqId,
    });

    const { osmToken, pathnames } = await runInTransaction(async (conn) => {
      const [userRow] = await conn.query<{ osmAccessToken: string | null }[]>(
        sql`SELECT osmAccessToken FROM user WHERE id = ${ctx.state.user!.id} FOR UPDATE`,
      );

      const rows = await conn.query<{ pathname: string }[]>(
        sql`SELECT pathname FROM picture WHERE userId = ${ctx.state.user!.id} FOR UPDATE`,
      );

      await conn.query<unknown>(
        sql`DELETE FROM user WHERE id = ${ctx.state.user!.id}`,
      );

      return {
        osmToken: userRow?.osmAccessToken,
        pathnames: rows.map((row) => row.pathname),
      };
    });

    // Only once committed: a rolled-back or retried deletion keeps them.
    await Promise.all(
      pathnames.map((pathname) =>
        unlink(`${picturesDir}/${pathname}`).catch((err) => {
          logger.error({ err }, 'Error deleting picture.');
        }),
      ),
    );

    // Gone with the row, it could never be revoked later.
    if (osmToken) {
      revokeOsmTokenLater(osmToken, logger);
    }

    ctx.status = 204;
  });
}
