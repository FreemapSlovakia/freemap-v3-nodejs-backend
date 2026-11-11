import type { PoolConnection } from 'mariadb';
import sql from 'sql-template-tag';
import z from 'zod';
import type { pool } from '../../database.js';

// An event's own map (`map.forEvent`): made from the event form, kept out of
// its creator's list, written by whoever may write the event, renamed with it
// and deleted with it or when the event links another map.

const EventOfMapSchema = z.object({ id: z.string(), userId: z.uint32() });

/** The event a map was made for and is linked by; none for an ordinary map. */
export async function eventOfMap(
  conn: PoolConnection | typeof pool,
  mapId: string,
): Promise<z.infer<typeof EventOfMapSchema> | undefined> {
  const [event] = EventOfMapSchema.array()
    .max(1)
    .parse(
      await conn.query<unknown>(sql`
        SELECT e.id, e.userId FROM event e JOIN map m ON m.id = e.mapId
          WHERE m.id = ${mapId} AND m.forEvent
          LIMIT 1
      `),
    );

  return event;
}

/** Names the event's own map, if it links one, after the event. */
export async function nameEventMap(conn: PoolConnection, eventId: string) {
  await conn.query<unknown>(
    sql`UPDATE map JOIN event ON event.mapId = map.id
      SET map.name = event.title
      WHERE event.id = ${eventId} AND map.forEvent`,
  );
}

/** Deletes an event's own map it no longer links. */
export async function dropEventMap(conn: PoolConnection, mapId: string) {
  await conn.query<unknown>(
    sql`DELETE FROM map WHERE id = ${mapId} AND forEvent AND NOT EXISTS (
      SELECT 1 FROM event WHERE mapId = ${mapId}
    )`,
  );
}
