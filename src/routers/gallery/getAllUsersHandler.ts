import Router from '@koa/router';
import { pool } from '../../database';
import { acceptValidator } from '../../requestValidators';

export function attachGetAllPictureUsers(router: Router) {
  router.get(
    '/picture-users',
    acceptValidator('application/json'),
    async ctx => {
      ctx.body = await pool.query(
        `SELECT userId AS id, user.name AS name, COUNT(*) AS count
          FROM picture
          JOIN user ON userId = user.id
          GROUP BY userId
          ORDER BY user.name`,
      );
    },
  );
}
