import { SQL } from 'sql-template-strings';
import { promises as fs } from 'fs';
import Router from '@koa/router';
import { runInTransaction } from '../../database';
import { authenticator } from '../../authenticator';
import { picturesDir } from '../gallery/constants';

export function attachDeletePictureHandler(router: Router) {
  router.delete(
    '/pictures/:id',
    authenticator(true),
    runInTransaction(),
    async (ctx) => {
      const conn = ctx.state.dbConn;

      const rows = await conn.query(
        SQL`SELECT pathname, userId FROM picture WHERE id = ${ctx.params.id} FOR UPDATE`,
      );

      if (rows.length === 0) {
        ctx.throw(404, 'no such picture');
      }

      if (!ctx.state.user?.isAdmin && rows[0].userId !== ctx.state.user?.id) {
        ctx.throw(403);
      }

      await conn.query(SQL`DELETE FROM picture WHERE id = ${ctx.params.id}`);

      await fs.unlink(`${picturesDir}/${rows[0].pathname}`);

      ctx.status = 204;
    },
  );
}
