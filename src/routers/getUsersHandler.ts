import Router from '@koa/router';
import { pool } from '../database';
import { acceptValidator } from '../requestValidators';

export function attachGetUsers(router: Router) {
  router.get('/users', acceptValidator('application/json'), async (ctx) => {
    ctx.body = await pool.query('SELECT id, name FROM user ORDER BY name');
  });
}
