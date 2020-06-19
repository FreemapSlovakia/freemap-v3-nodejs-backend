import Router from '@koa/router';
import { pool } from '../../database';
import { acceptValidator } from '../../requestValidators';

export function attachGetAllTagsHandler(router: Router) {
  router.get(
    '/picture-tags',
    acceptValidator('application/json'),
    async (ctx) => {
      ctx.body = await pool.query(
        'SELECT name, count(*) AS count FROM pictureTag GROUP BY name ORDER BY name',
      );
    },
  );
}
