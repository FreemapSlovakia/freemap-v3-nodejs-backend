import type { ParameterizedContext } from 'koa';
import type { PoolConnection } from 'mariadb';
import sql from 'sql-template-tag';
import z from 'zod';
import { canWriteEvent } from './types.js';

const MapAccessRowSchema = z.object({
  userId: z.uint32(),
  writers: z
    .string()
    .nullable()
    .transform((w) => (w ? w.split(',').map(Number) : []))
    .pipe(z.number().array()),
});

/** Throws unless the map exists and the user may write it, and so its event. */
export async function assertMapWritable(
  ctx: ParameterizedContext,
  conn: PoolConnection,
  mapId: string,
) {
  const [map] = MapAccessRowSchema.array()
    .max(1)
    .parse(
      await conn.query<unknown>(sql`
        SELECT userId,
          (SELECT GROUP_CONCAT(userId) FROM mapWriteAccess WHERE mapId = map.id) AS writers
        FROM map WHERE id = ${mapId} FOR UPDATE
      `),
    );

  if (!map) {
    ctx.throw(404, 'no such map');
  }

  if (!canWriteEvent(ctx.state.user, map)) {
    ctx.throw(403);
  }
}
