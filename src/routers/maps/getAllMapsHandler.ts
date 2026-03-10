import { RouterInstance } from '@koa/router';
import sql from 'sql-template-tag';
import z from 'zod';
import { authenticator } from '../../authenticator.js';
import { pool } from '../../database.js';
import { registerPath } from '../../openapi.js';
import { acceptValidator } from '../../requestValidators.js';
import { MapMetaSchema } from '../../types.js';

const DbRowSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  public: z.number().int(),
  userId: z.uint32(),
  writers: z.string().nullable(),
  createdAt: z.date(),
  modifiedAt: z.date(),
});

export function attachGetAllMapsHandler(router: RouterInstance) {
  registerPath('/maps', {
    get: {
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
    authenticator(true),
    async (ctx) => {
      const user = ctx.state.user!;

      const items = DbRowSchema.array().parse(
        await pool.query(sql`
          SELECT id, name, public, createdAt, modifiedAt, map.userId, GROUP_CONCAT(mapWriteAccess.userId) AS writers
            FROM map LEFT JOIN mapWriteAccess ON (mapWriteAccess.mapId = id)
            WHERE map.userId = ${user.id}
            GROUP BY id, name, public, createdAt, modifiedAt, map.userId
        `),
      );

      ctx.body = items.map((item) => {
        const writers = item.writers?.split(',').map((s) => Number(s)) ?? [];

        return MapMetaSchema.parse({
          id: item.id,
          createdAt: item.createdAt.toISOString(),
          modifiedAt: item.modifiedAt.toISOString(),
          name: item.name,
          userId: item.userId,
          public: !!item.public,
          writers: item.userId === user.id ? writers : undefined,
          canWrite: item.userId === user.id || writers.includes(user.id),
        });
      });
    },
  );
}
