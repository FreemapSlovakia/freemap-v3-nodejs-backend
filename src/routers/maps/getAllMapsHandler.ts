import type { RouterInstance } from '@koa/router';
import sql from 'sql-template-tag';
import z from 'zod';
import { authenticator } from '../../authenticator.js';
import { pool } from '../../database.js';
import { AUTH_REQUIRED, registerPath } from '../../openapi.js';
import { acceptValidator } from '../../requestValidators.js';
import { MapMetaSchema, MapUserSchema, zDateToIso } from '../../types.js';

const DbRowSchema = z.object({
  id: z.string().nonempty(),
  name: z.string().nullable(),
  userId: z.uint32(),
  editors: z.preprocess(
    (e) => (typeof e === 'string' ? JSON.parse(e) : (e ?? [])),
    MapUserSchema.array(),
  ),
  ownerName: z.string(),
  ownerHasPicture: z.coerce.boolean(),
  ownerPremium: z.coerce.boolean(),
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
          SELECT map.id, map.name, map.createdAt, map.modifiedAt, map.userId,
              owner.name AS ownerName, owner.picture IS NOT NULL AS ownerHasPicture,
              (owner.premiumExpiration IS NOT NULL AND owner.premiumExpiration > NOW()) AS ownerPremium,
              (SELECT JSON_ARRAYAGG(JSON_OBJECT('id', u.id, 'name', u.name, 'hasPicture', u.picture IS NOT NULL,
                  'premium', (u.premiumExpiration IS NOT NULL AND u.premiumExpiration > NOW())) ORDER BY u.name)
                FROM mapWriteAccess mwa JOIN user u ON u.id = mwa.userId WHERE mwa.mapId = map.id) AS editors,
              (SELECT GROUP_CONCAT(mt.tag ORDER BY mt.tag SEPARATOR '\n') FROM mapTag mt WHERE mt.mapId = map.id AND mt.userId = ${user.id}) AS tags
            -- A UNION, as an OR across the two would scan every map.
            FROM (
              SELECT id FROM map WHERE userId = ${user.id}
              UNION SELECT mapId FROM mapWriteAccess WHERE userId = ${user.id}
            ) mine
            JOIN map ON map.id = mine.id
            JOIN user owner ON owner.id = map.userId
            WHERE NOT map.forEvent
        `),
      );

      ctx.body = items.map((item) => {
        const isOwner = item.userId === user.id;

        return MapMetaSchema.parse({
          id: item.id,
          createdAt: item.createdAt,
          modifiedAt: item.modifiedAt,
          name: item.name,
          userId: item.userId,
          public: true,
          writers: isOwner ? item.editors.map((e) => e.id) : undefined,
          editors: isOwner ? item.editors : undefined,
          // Only maps the user owns or writes are listed.
          canWrite: true,
          tags: item.tags,
          owner: {
            id: item.userId,
            name: item.ownerName,
            hasPicture: item.ownerHasPicture,
            premium: item.ownerPremium,
          },
        });
      });
    },
  );
}
