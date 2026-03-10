import { RouterInstance } from '@koa/router';
import sql from 'sql-template-tag';
import z from 'zod';
import { authenticator } from '../../authenticator.js';
import { pool } from '../../database.js';
import { AUTH_OPTIONAL, registerPath } from '../../openapi.js';
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
  data: z.string(),
});

const ResponseSchema = z.strictObject({
  meta: MapMetaSchema,
  data: z.record(z.string(), z.unknown()),
});

export function attachGetMapHandler(router: RouterInstance) {
  registerPath('/maps/{id}', {
    get: {
      security: AUTH_OPTIONAL,
      parameters: [
        {
          in: 'path',
          name: 'id',
          required: true,
          schema: { type: 'string' },
        },
      ],
      responses: {
        200: {
          content: {
            'application/json': {
              schema: ResponseSchema,
            },
          },
        },
        403: {},
        404: { description: 'no such map' },
      },
    },
  });

  router.get(
    '/:id',
    acceptValidator('application/json'),
    authenticator(false),
    async (ctx) => {
      const [item] = DbRowSchema.array()
        .max(1)
        .parse(
          await pool.query(sql`
          SELECT id, name, public, data, createdAt, modifiedAt, map.userId, GROUP_CONCAT(mapWriteAccess.userId) AS writers
            FROM map LEFT JOIN mapWriteAccess ON (mapWriteAccess.mapId = id)
            WHERE id = ${ctx.params.id}
            GROUP BY id, name, public, data, createdAt, map.userId
        `),
        );

      if (!item) {
        ctx.throw(404, 'no such map');
      }

      const { user } = ctx.state;

      if (
        !item.public &&
        (!user || (!user.isAdmin && user.id !== item.userId))
      ) {
        ctx.throw(403);
      }

      const writers =
        item.writers?.split(',').map((s: string) => Number(s)) ?? [];

      ctx.body = ResponseSchema.parse({
        meta: MapMetaSchema.parse({
          id: item.id,
          createdAt: item.createdAt.toISOString(),
          modifiedAt: item.modifiedAt.toISOString(),
          name: item.name,
          userId: item.userId,
          public: !!item.public,
          writers: item.userId === user?.id ? writers : undefined,
          canWrite: !!(
            user &&
            (item.userId === user.id || writers.includes(user.id))
          ),
        }),
        data: JSON.parse(item.data),
      });
    },
  );
}
