import { RouterInstance } from '@koa/router';
import sql from 'sql-template-tag';
import z from 'zod';
import { pool } from '../database.js';
import { registerPath } from '../openapi.js';
import { acceptValidator } from '../requestValidators.js';

const ResponseSchema = z.array(
  z.strictObject({ id: z.uint32(), name: z.string() }),
);

export function attachGetUsers(router: RouterInstance) {
  registerPath('/users', {
    get: {
      summary: 'List users',
      tags: ['users'],
      responses: {
        200: { content: { 'application/json': { schema: ResponseSchema } } },
      },
    },
  });

  router.get('/users', acceptValidator('application/json'), async (ctx) => {
    ctx.body = ResponseSchema.parse(
      await pool.query(sql`SELECT id, name FROM user ORDER BY name`),
    );
  });
}
