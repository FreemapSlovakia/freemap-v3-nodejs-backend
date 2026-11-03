import type { RouterInstance } from '@koa/router';
import sql from 'sql-template-tag';
import z from 'zod';
import { authenticator } from '../../authenticator.js';
import { pool } from '../../database.js';
import { AUTH_OPTIONAL, registerPath } from '../../openapi.js';
import { acceptValidator } from '../../requestValidators.js';
import { MapMetaSchema, zDateToIso } from '../../types.js';

const DbRowSchema = z.object({
  id: z.string().nonempty(),
  name: z.string().nullable(),
  userId: z.uint32(),
  writers: z.string().nullable(),
  createdAt: zDateToIso,
  modifiedAt: zDateToIso,
  data: z.string(),
});

const ResponseSchema = z.strictObject({
  meta: MapMetaSchema,
  data: z.record(z.string(), z.unknown()),
});

export function attachGetMapHandler(router: RouterInstance) {
  registerPath('/maps/{id}', {
    get: {
      summary: 'Get a map by ID',
      tags: ['maps'],
      security: AUTH_OPTIONAL,
      requestParams: {
        path: z.object({
          id: z.string().nonempty(),
        }),
      },
      responses: {
        200: {
          content: {
            'application/json': {
              schema: ResponseSchema,
            },
          },
        },
        404: { description: 'no such map' },
      },
    },
  });

  router.get(
    '/:id',
    acceptValidator('application/json'),
    authenticator(false, 'maps:read'),
    async (ctx) => {
      const [item] = DbRowSchema.array()
        .max(1)
        .parse(
          await pool.query<unknown>(sql`
          SELECT id, name, data, createdAt, modifiedAt, map.userId, GROUP_CONCAT(mapWriteAccess.userId) AS writers
            FROM map LEFT JOIN mapWriteAccess ON (mapWriteAccess.mapId = id)
            WHERE id = ${ctx.params.id}
            GROUP BY id, name, data, createdAt, map.userId
        `),
        );

      if (!item) {
        ctx.throw(404, 'no such map');
      }

      const { user } = ctx.state;

      const writers = item.writers?.split(',').map((s) => Number(s)) ?? [];

      ctx.body = ResponseSchema.parse({
        meta: MapMetaSchema.parse({
          id: item.id,
          createdAt: item.createdAt,
          modifiedAt: item.modifiedAt,
          name: item.name,
          userId: item.userId,
          public: true,
          writers: item.userId === user?.id ? writers : undefined,
          canWrite: Boolean(
            user && (item.userId === user.id || writers.includes(user.id)),
          ),
        }),
        data: JSON.parse(item.data),
      });
    },
  );
}
