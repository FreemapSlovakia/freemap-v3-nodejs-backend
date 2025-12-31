import { RouterInstance } from '@koa/router';
import { pool } from '../../database.js';
import { acceptValidator } from '../../requestValidators.js';

export function attachGetAllTagsHandler(router: RouterInstance) {
  router.get(
    '/picture-tags',
    acceptValidator('application/json'),
    async (ctx) => {
      ctx.body = await pool.query(
        'SELECT name, COUNT(*) AS count FROM pictureTag GROUP BY name ORDER BY name',
      );
    },
  );
}
