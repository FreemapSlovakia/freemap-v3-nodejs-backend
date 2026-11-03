import type { ParameterizedContext } from 'koa';
import type { PoolConnection } from 'mariadb';
import sql from 'sql-template-tag';
import z from 'zod';

/**
 * Throws unless the map exists, is public, and belongs to the event's owner —
 * not to whoever edits it, which a moderator may.
 */
export async function assertOwnMap(
  ctx: ParameterizedContext,
  conn: PoolConnection,
  mapId: string,
  ownerId: number,
) {
  const [map] = z
    .array(z.object({ userId: z.uint32(), public: z.boolean() }))
    .max(1)
    .parse(
      await conn.query<unknown>(
        sql`SELECT userId, public FROM map WHERE id = ${mapId}`,
      ),
    );

  if (!map) {
    ctx.throw(404, 'no such map');
  }

  if (map.userId !== ownerId) {
    ctx.throw(403, 'only a map of the event’s owner can be linked');
  }

  // Participants open it by its link, which a private map refuses them.
  if (!map.public) {
    ctx.throw(409, 'only a public map can be linked');
  }
}
