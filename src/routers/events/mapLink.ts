import type { ParameterizedContext } from 'koa';
import type { PoolConnection } from 'mariadb';
import sql from 'sql-template-tag';
import z from 'zod';

/**
 * Throws unless the map may be linked: one of the event's owner — not of
 * whoever edits it, which a moderator may — or an event's own map, made by the
 * caller and linked by no other event.
 */
export async function assertOwnMap(
  ctx: ParameterizedContext,
  conn: PoolConnection,
  mapId: string,
  ownerId: number,
  /** The event being edited, and whether it links the map already. */
  edited?: { id: string; links: boolean },
) {
  const [map] = z
    .array(
      z.object({
        userId: z.uint32(),
        forEvent: z.coerce.boolean(),
      }),
    )
    .max(1)
    .parse(
      // Locked, so two saves can't both take an event's own map.
      await conn.query<unknown>(
        sql`SELECT userId, forEvent FROM map WHERE id = ${mapId} FOR UPDATE`,
      ),
    );

  if (!map) {
    ctx.throw(404, 'no such map');
  }

  if (map.forEvent) {
    // A locking read sees what the other save committed.
    const [linked] = await conn.query<unknown[]>(
      sql`SELECT id FROM event WHERE mapId = ${mapId} AND id <> ${edited?.id ?? ''} LIMIT 1 FOR UPDATE`,
    );

    if (linked) {
      ctx.throw(409, 'the map is another event’s own');
    }

    if (map.userId !== ctx.state.user?.id && !edited?.links) {
      ctx.throw(403, 'an event’s own map is linked by whoever made it');
    }

    return;
  }

  if (map.userId !== ownerId) {
    ctx.throw(403, 'only a map of the event’s owner can be linked');
  }
}
