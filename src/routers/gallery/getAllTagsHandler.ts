import type { RouterInstance } from '@koa/router';
import sql from 'sql-template-tag';
import z from 'zod';
import { pool } from '../../database.js';
import { registerPath } from '../../openapi.js';
import { acceptValidator } from '../../requestValidators.js';
import { LATIN } from './tagNames.js';
import { LangQuerySchema, TagListSchema } from './tags.js';

const QuerySchema = z.object({ lang: LangQuerySchema });

const ResponseSchema = z.array(
  z.strictObject({
    ...TagListSchema.element.shape,
    count: z.uint32().meta({ description: 'number of pictures with that tag' }),
  }),
);

export function attachGetAllTagsHandler(router: RouterInstance) {
  registerPath('/gallery/picture-tags', {
    get: {
      summary: 'List all gallery picture tags',
      tags: ['gallery'],
      requestParams: { query: QuerySchema },
      responses: {
        200: { content: { 'application/json': { schema: ResponseSchema } } },
      },
    },
  });

  router.get(
    '/picture-tags',
    acceptValidator('application/json'),
    async (ctx) => {
      const { lang } = QuerySchema.catch({}).parse(ctx.query);

      // Counted by tag first, on ptTagIdx; labels joined to the counts.
      ctx.body = ResponseSchema.parse(
        await pool.query<unknown>(
          sql`SELECT t.id, t.name, tl.label, la.label AS latin, c.count
            FROM (SELECT tagId, COUNT(*) AS count FROM pictureTag GROUP BY tagId) c
            JOIN tag t ON t.id = c.tagId
            LEFT JOIN tagLabel tl ON tl.tagId = t.id AND tl.language = ${lang ?? ''}
            LEFT JOIN tagLabel la ON la.tagId = t.id AND la.language = ${LATIN}
            ORDER BY t.name`,
        ),
      );
    },
  );
}
