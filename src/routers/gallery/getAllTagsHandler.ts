import type { RouterInstance } from '@koa/router';
import sql from 'sql-template-tag';
import z from 'zod';
import { pool } from '../../database.js';
import { registerPath } from '../../openapi.js';
import { acceptValidator } from '../../requestValidators.js';
import { LATIN } from './tagNames.js';
import { LangQuerySchema, TagListSchema } from './tags.js';

const QuerySchema = z.object({ lang: LangQuerySchema });

const TagSchema = z.strictObject({
  ...TagListSchema.element.shape,
  count: z.uint32().meta({ description: 'number of pictures with that tag' }),
  parentId: z
    .uint32()
    .nullable()
    .meta({ description: 'the broader tag; filtering by it finds this one' }),
});

const ResponseSchema = z.array(
  z.strictObject({
    ...TagSchema.shape,
    synonyms: z
      .array(z.string())
      .meta({ description: 'other words that find the tag' }),
  }),
);

const RowSchema = z.array(
  z.strictObject({ ...TagSchema.shape, synonyms: z.string().nullable() }),
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

      // Counted by tag first, on ptTagIdx; labels joined to the counts. A
      // broader tag without photos of its own is listed too, to filter by.
      const rows = RowSchema.parse(
        await pool.query<unknown>(
          sql`SELECT t.id, t.name, tl.label, la.label AS latin, COALESCE(c.count, 0) AS count, t.parentId, s.synonyms
            FROM tag t
            LEFT JOIN (SELECT tagId, COUNT(*) AS count FROM pictureTag GROUP BY tagId) c ON c.tagId = t.id
            LEFT JOIN tagLabel tl ON tl.tagId = t.id AND tl.language = ${lang ?? ''}
            LEFT JOIN tagLabel la ON la.tagId = t.id AND la.language = ${LATIN}
            LEFT JOIN (SELECT tagId, GROUP_CONCAT(synonym ORDER BY synonym SEPARATOR '\n') AS synonyms
              FROM tagSynonym GROUP BY tagId) s ON s.tagId = t.id
            WHERE c.count IS NOT NULL OR t.id IN (SELECT parentId FROM tag)
            ORDER BY t.name`,
        ),
      );

      ctx.body = ResponseSchema.parse(
        rows.map((row) => ({
          ...row,
          synonyms: row.synonyms ? row.synonyms.split('\n') : [],
        })),
      );
    },
  );
}
