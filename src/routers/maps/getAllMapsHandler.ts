import type { RouterInstance } from '@koa/router';
import sql from 'sql-template-tag';
import z from 'zod';
import { authenticator } from '../../authenticator.js';
import { pool } from '../../database.js';
import { AUTH_REQUIRED, registerPath } from '../../openapi.js';
import { acceptValidator } from '../../requestValidators.js';
import { MapMetaSchema, zDateToIso } from '../../types.js';

const DbRowSchema = z.object({
  id: z.string().nonempty(),
  name: z.string().nullable(),
  userId: z.uint32(),
  writers: z
    .string()
    .nullable()
    .transform((w) => (w ? w.split(',').map(Number) : []))
    .pipe(z.number().array()),
  ownerName: z.string(),
  tags: z
    .string()
    .nullable()
    .transform((t) => (t ? t.split('\n') : [])),
  createdAt: zDateToIso,
  modifiedAt: zDateToIso,
});

export function attachGetAllMapsHandler(router: RouterInstance) {
  registerPath('/maps', {
    get: {
      tags: ['maps'],
      summary:
        'List the maps the authenticated user owns or may write, with their own tags',
      security: AUTH_REQUIRED,
      responses: {
        200: {
          content: { 'application/json': { schema: MapMetaSchema.array() } },
        },
        401: {},
      },
    },
  });

  router.get(
    '/',
    acceptValidator('application/json'),
    authenticator(true, 'maps:read'),
    async (ctx) => {
      const user = ctx.state.user!;

      const items = DbRowSchema.array().parse(
        await pool.query<unknown>(sql`
          SELECT map.id, map.name, map.createdAt, map.modifiedAt, map.userId, user.name AS ownerName,
              (SELECT GROUP_CONCAT(mwa.userId) FROM mapWriteAccess mwa WHERE mwa.mapId = map.id) AS writers,
              (SELECT GROUP_CONCAT(mt.tag ORDER BY mt.tag SEPARATOR '\n') FROM mapTag mt WHERE mt.mapId = map.id AND mt.userId = ${user.id}) AS tags
            -- A UNION, as an OR across the two would scan every map.
            FROM (
              SELECT id FROM map WHERE userId = ${user.id}
              UNION SELECT mapId FROM mapWriteAccess WHERE userId = ${user.id}
            ) mine
            JOIN map ON map.id = mine.id
            JOIN user ON user.id = map.userId
            WHERE NOT map.forEvent
        `),
      );

      ctx.body = items.map((item) => {
        return MapMetaSchema.parse({
          id: item.id,
          createdAt: item.createdAt,
          modifiedAt: item.modifiedAt,
          name: item.name,
          userId: item.userId,
          public: true,
          writers: item.userId === user.id ? item.writers : undefined,
          // Only maps the user owns or writes are listed.
          canWrite: true,
          tags: item.tags,
          ownerName: item.ownerName,
        });
      });
    },
  );
}
