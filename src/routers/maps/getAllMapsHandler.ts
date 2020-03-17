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
    async ctx => {
      ctx.body = await pool.query(SQL`
        SELECT id, name, public, createdAt, userId
          FROM map
          WHERE userId = ${ctx.state.user.id}
      `);

      for (const item of ctx.body) {
        item.public = !!item.public;
      }
    },
  );
}
