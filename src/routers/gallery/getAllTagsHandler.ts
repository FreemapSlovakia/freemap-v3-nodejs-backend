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
  total: z.uint32().meta({
    description:
      'number of pictures filtering by the tag finds, its narrower tags included',
  }),
});

const ResponseSchema = z.array(
  z.strictObject({
    ...TagSchema.shape,
    parentIds: z.array(z.uint32()).meta({
      description: 'the broader tags; filtering by one finds this one',
    }),
    synonyms: z
      .array(z.string())
      .meta({ description: 'other words that find the tag' }),
  }),
);

const RowSchema = z.array(
  z.strictObject({
    ...TagSchema.shape,
    parentIds: z.string().nullable(),
    synonyms: z.string().nullable(),
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

      // Counted by tag first, on ptTagIdx; labels joined to the counts. A
      // broader tag without photos of its own is listed too, to filter by.
      // Its total counts each photo of its subtree once, as the filter finds
      // them; UNION stops at cycles. ~90 ms on production data (2026-11).
      // TODO cache it until tags change, should it grow slow.
      const rows = RowSchema.parse(
        await pool.query<unknown>(
          sql`WITH RECURSIVE sub AS (
              SELECT parentId AS rootId, parentId AS tagId FROM tagParent
              UNION SELECT sub.rootId, tp.tagId FROM sub JOIN tagParent tp ON tp.parentId = sub.tagId
            ), tot AS (
              SELECT sub.rootId, COUNT(DISTINCT pt.pictureId) AS total FROM sub JOIN pictureTag pt ON pt.tagId = sub.tagId GROUP BY sub.rootId
            )
            SELECT t.id, t.name, tl.label, la.label AS latin, COALESCE(c.count, 0) AS count,
              COALESCE(tot.total, c.count, 0) AS total, p.parentIds, s.synonyms
            FROM tag t
            LEFT JOIN (SELECT tagId, COUNT(*) AS count FROM pictureTag GROUP BY tagId) c ON c.tagId = t.id
            LEFT JOIN tot ON tot.rootId = t.id
            LEFT JOIN tagLabel tl ON tl.tagId = t.id AND tl.language = ${lang ?? ''}
            LEFT JOIN tagLabel la ON la.tagId = t.id AND la.language = ${LATIN}
            LEFT JOIN (SELECT tagId, GROUP_CONCAT(parentId ORDER BY parentId) AS parentIds FROM tagParent GROUP BY tagId) p ON p.tagId = t.id
            LEFT JOIN (SELECT tagId, GROUP_CONCAT(synonym ORDER BY synonym SEPARATOR '\n') AS synonyms
              FROM tagSynonym GROUP BY tagId) s ON s.tagId = t.id
            WHERE c.count IS NOT NULL OR t.id IN (SELECT parentId FROM tagParent)
            ORDER BY t.name`,
        ),
      );

      ctx.body = ResponseSchema.parse(
        rows.map((row) => ({
          ...row,
          parentIds: row.parentIds ? row.parentIds.split(',').map(Number) : [],
          synonyms: row.synonyms ? row.synonyms.split('\n') : [],
        })),
      );
    },
  );
}
