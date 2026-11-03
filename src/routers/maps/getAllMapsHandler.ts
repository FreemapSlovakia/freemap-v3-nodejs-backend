import type { RouterInstance } from '@koa/router';
import sql, { raw } from 'sql-template-tag';
import z from 'zod';
import { authenticator } from '../../authenticator.js';
import { pool } from '../../database.js';
import { AUTH_REQUIRED, registerPath } from '../../openapi.js';
import { acceptValidator } from '../../requestValidators.js';
import { zDateToIso } from '../../types.js';
import {
  MAP_EVENT_COLUMNS_SQL,
  MapEventRowSchema,
  mapEventFields,
} from '../events/types.js';
import { MapMetaWithEventSchema } from './types.js';

const DbRowSchema = z.object({
  id: z.string().nonempty(),
  name: z.string().nullable(),
  public: z.boolean(),
  userId: z.uint32(),
  writers: z
    .string()
    .nullable()
    .transform((w) => (w ? w.split(',').map(Number) : []))
    .pipe(z.number().array()),
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
          content: {
            'application/json': { schema: MapMetaWithEventSchema.array() },
          },
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
          SELECT id, name, public, createdAt, modifiedAt, map.userId, GROUP_CONCAT(mapWriteAccess.userId) AS writers
            FROM map LEFT JOIN mapWriteAccess ON (mapWriteAccess.mapId = id)
            WHERE map.userId = ${user.id}
            GROUP BY id, name, public, createdAt, modifiedAt, map.userId
        `),
      );

      const events = new Map(
        MapEventRowSchema.array()
          .parse(
            await pool.query<unknown>(sql`
              SELECT ${raw(MAP_EVENT_COLUMNS_SQL)}
              FROM mapEvent e JOIN map ON map.id = e.mapId
              WHERE map.userId = ${user.id}
            `),
          )
          .map((row) => [row.mapId, mapEventFields(row)]),
      );

      ctx.body = items.map((item) => {
        return MapMetaWithEventSchema.parse({
          event: events.get(item.id) ?? null,
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
