import sql from 'sql-template-tag';
import { promises as fs } from 'fs';
import Router from '@koa/router';
import { runInTransaction } from '../../database.js';
import { authenticator } from '../../authenticator.js';
import { picturesDir } from '../gallery/constants.js';

export function attachDeletePictureHandler(router: Router) {
  router.delete(
    '/pictures/:id',
    authenticator(true),
    runInTransaction(),
    async (ctx) => {
      const conn = ctx.state.dbConn;

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

      await fs.unlink(`${picturesDir}/${rows[0].pathname}`);

      ctx.status = 204;
    },
  );
}
