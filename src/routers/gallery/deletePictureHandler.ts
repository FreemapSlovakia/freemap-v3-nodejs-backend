import { unlink } from 'node:fs/promises';
import { RouterInstance } from '@koa/router';
import sql from 'sql-template-tag';
import { authenticator } from '../../authenticator.js';
import { runInTransaction } from '../../database.js';
import { picturesDir } from '../gallery/constants.js';

export function attachDeletePictureHandler(router: RouterInstance) {
  router.delete('/pictures/:id', authenticator(true), async (ctx) => {
    const pathname = await runInTransaction(async (conn) => {
      const rows = await conn.query(
        sql`SELECT pathname, userId FROM picture WHERE id = ${ctx.params.id} FOR UPDATE`,
      );

      if (rows.length === 0) {
        ctx.throw(404, 'no such picture');
      }

      if (!ctx.state.user?.isAdmin && rows[0].userId !== ctx.state.user?.id) {
        ctx.throw(403);
      }

      await conn.query(sql`DELETE FROM picture WHERE id = ${ctx.params.id}`);

      return rows[0].pathname;
    });

    await unlink(`${picturesDir}/${pathname}`);

    ctx.status = 204;
  });
}
