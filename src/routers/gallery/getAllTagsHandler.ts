import { RouterInstance } from '@koa/router';
import sql from 'sql-template-tag';
import z from 'zod';
import { pool } from '../../database.js';
import { registerPath } from '../../openapi.js';
import { acceptValidator } from '../../requestValidators.js';

const ResponseSchema = z.array(
  z.strictObject({
    name: z.string(),
    count: z.uint32().meta({ description: 'number of pictures with that tag' }),
  }),
);

export function attachGetAllTagsHandler(router: RouterInstance) {
  registerPath('/gallery/picture-tags', {
    get: {
      summary: 'List all gallery picture tags',
      tags: ['gallery'],
      responses: {
        200: { content: { 'application/json': { schema: ResponseSchema } } },
      },
    },
  });

  router.get(
    '/picture-tags',
    acceptValidator('application/json'),
    async (ctx) => {
      ctx.body = ResponseSchema.parse(
        await pool.query(
          sql`SELECT name, COUNT(*) AS count FROM pictureTag GROUP BY name ORDER BY name`,
        ),
      );
    },
  );
}
