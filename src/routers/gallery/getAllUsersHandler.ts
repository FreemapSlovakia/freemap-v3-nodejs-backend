import { RouterInstance } from '@koa/router';
import sql from 'sql-template-tag';
import z from 'zod';
import { pool } from '../../database.js';
import { registerPath } from '../../openapi.js';
import { acceptValidator } from '../../requestValidators.js';

const ResponseSchema = z.array(
  z.strictObject({
    id: z.uint32(),
    name: z.string(),
    count: z.uint32().meta({ description: 'number of pictures of that user' }),
  }),
);

export function attachGetAllPictureUsers(router: RouterInstance) {
  registerPath('/gallery/picture-users', {
    get: {
      responses: {
        200: { content: { 'application/json': { schema: ResponseSchema } } },
      },
    },
  });

  router.get(
    '/picture-users',
    acceptValidator('application/json'),
    async (ctx) => {
      ctx.body = ResponseSchema.parse(
        await pool.query(sql`SELECT userId AS id, user.name AS name, COUNT(*) AS count
          FROM picture
          JOIN user ON userId = user.id
          GROUP BY userId
          ORDER BY user.name`),
      );
    },
  );
}
