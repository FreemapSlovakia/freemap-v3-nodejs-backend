import { RouterInstance } from '@koa/router';
import sql from 'sql-template-tag';
import z from 'zod';
import { authenticator } from '../../authenticator.js';
import { pool } from '../../database.js';
import { AUTH_REQUIRED, registerPath } from '../../openapi.js';
import { acceptValidator } from '../../requestValidators.js';
import { MapMetaSchema, zDateToIso } from '../../types.js';

const DbRowSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  public: z.number().transform(Boolean),
  userId: z.uint32(),
  writers: z
    .string()
    .nullable()
    .transform((w) => (w ? w.split(',').map(Number) : [])),
  createdAt: zDateToIso,
  modifiedAt: zDateToIso,
});

export function attachGetAllMapsHandler(router: RouterInstance) {
  registerPath('/maps', {
    get: {
      tags: ['maps'],
      summary: 'List all maps owned by the authenticated user',
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
        return MapMetaSchema.parse({
          id: item.id,
          createdAt: item.createdAt,
          modifiedAt: item.modifiedAt,
          name: item.name,
          userId: item.userId,
          public: item.public,
          writers: item.userId === user.id ? item.writers : undefined,
          canWrite: item.userId === user.id || item.writers.includes(user.id),
        });
      });
    },
  );
}
