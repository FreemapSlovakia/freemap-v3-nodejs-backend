import Router from '@koa/router';
import { pool } from '../database.js';
import { acceptValidator } from '../requestValidators.js';

export function attachGetUsers(router: Router) {
  router.get('/users', acceptValidator('application/json'), async (ctx) => {
    ctx.body = await pool.query('SELECT id, name FROM user ORDER BY name');
  });
}
