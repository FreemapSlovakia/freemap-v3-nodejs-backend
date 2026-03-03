import { RouterInstance } from '@koa/router';
import sql from 'sql-template-tag';
import { pool } from '../database.js';
import { acceptValidator } from '../requestValidators.js';

export function attachGetUsers(router: RouterInstance) {
  router.get('/users', acceptValidator('application/json'), async (ctx) => {
    ctx.body = await pool.query(sql`SELECT id, name FROM user ORDER BY name`);
  });
}
