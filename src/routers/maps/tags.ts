import type { PoolConnection } from 'mariadb';
import sql, { bulk } from 'sql-template-tag';
import z from 'zod';
import { oneLine } from '../gallery/tagNames.js';

// One line, as the list joins tags with newlines. Duplicates, also by the
// column's collation, are dropped by `INSERT IGNORE`.
export const MapTagsSchema = z
  .array(z.string().transform(oneLine).pipe(z.string().min(1).max(64)))
  .max(50);

export async function setMapTags(
  conn: Pick<PoolConnection, 'query'>,
  mapId: string,
  userId: number,
  tags: string[],
) {
  await conn.query(
    sql`DELETE FROM mapTag WHERE mapId = ${mapId} AND userId = ${userId}`,
  );

  if (tags.length) {
    await conn.query(
      sql`INSERT IGNORE INTO mapTag (mapId, userId, tag) VALUES ${bulk(tags.map((tag) => [mapId, userId, tag]))}`,
    );
  }
}
