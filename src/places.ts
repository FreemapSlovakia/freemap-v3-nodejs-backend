import type { PoolConnection } from 'mariadb';
import sql, { raw } from 'sql-template-tag';
import z from 'zod';
import { USER_COLUMNS_SQL, UserRowSchema } from './types.js';

export const MAX_PLACES = 20;

/** Without premium. */
export const FREE_PLACES = 1;

export const PlaceRowSchema = z.object({
  id: z.number(),
  name: z.string(),
  lat: z.coerce.number(),
  lon: z.coerce.number(),
});

export type PlaceRow = z.infer<typeof PlaceRowSchema>;

// What a home location from a legacy client or a login provider is named.
const HOME_NAMES: Record<string, string> = {
  sk: 'Domov',
  cs: 'Domov',
  de: 'Zuhause',
  hu: 'Otthon',
  it: 'Casa',
  pl: 'Dom',
  sl: 'Dom',
  fr: 'Domicile',
};

/**
 * Turns each account's home location into its first place; `userPlace` is the
 * truth from then on and `user.lat`/`lon` only mirrors it (see
 * `mirrorLegacyHome`). Idempotent: skips accounts that have places.
 */
export const MIGRATE_HOMES_SQL = `INSERT INTO userPlace (userId, name, lat, lon)
  SELECT u.id, CASE u.language ${Object.entries(HOME_NAMES)
    .map(([lang, name]) => `WHEN '${lang}' THEN '${name}'`)
    .join(' ')} ELSE 'Home' END, u.lat, u.lon
  FROM user u
  WHERE u.lat IS NOT NULL AND u.lon IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM userPlace p WHERE p.userId = u.id)`;

/**
 * Locks the user's row, which every write of their places takes first: the
 * count against the limit and the mirrored home must not race. Returns whether
 * the user has premium, or null when the account is gone (merged, deleted).
 */
export async function lockPlacesOwner(
  conn: PoolConnection,
  userId: number,
): Promise<boolean | null> {
  const [row] = await conn.query<unknown[]>(
    sql`SELECT ${raw(USER_COLUMNS_SQL)} FROM user WHERE id = ${userId} FOR UPDATE`,
  );

  return row ? UserRowSchema.parse(row).premium : null;
}

/** The user's places, the first (the legacy home) first. */
export async function placesOf(
  conn: Pick<PoolConnection, 'query'>,
  userId: number,
): Promise<PlaceRow[]> {
  return PlaceRowSchema.array().parse(
    await conn.query<unknown>(
      sql`SELECT id, name, lat, lon FROM userPlace WHERE userId = ${userId} ORDER BY id`,
    ),
  );
}

/** Sets the legacy home to the first place, or clears it when there is none. */
export async function mirrorLegacyHome(
  conn: PoolConnection,
  userId: number,
): Promise<void> {
  await conn.query<unknown>(sql`
    UPDATE user u
    LEFT JOIN (
      SELECT lat, lon FROM userPlace WHERE userId = ${userId} ORDER BY id LIMIT 1
    ) p ON TRUE
    SET u.lat = p.lat, u.lon = p.lon
    WHERE u.id = ${userId}
  `);
}

/** A home location given as such: a new account's, or a legacy client's. */
export async function addHomePlace(
  conn: PoolConnection,
  userId: number,
  home: { lat: number; lon: number },
  language: string | null,
): Promise<void> {
  await conn.query<unknown>(
    sql`INSERT INTO userPlace SET userId = ${userId}, name = ${HOME_NAMES[language ?? ''] ?? 'Home'}, lat = ${home.lat}, lon = ${home.lon}`,
  );

  await mirrorLegacyHome(conn, userId);
}

/**
 * A legacy client set or removed its home: that is the first place, moved or
 * deleted, or a new one where there is none.
 */
export async function applyLegacyHome(
  conn: PoolConnection,
  userId: number,
  home: { lat: number; lon: number } | null,
  language: string | null,
): Promise<void> {
  const [first] = await placesOf(conn, userId);

  if (!first) {
    if (home) {
      await addHomePlace(conn, userId, home, language);
    }

    return;
  }

  await conn.query<unknown>(
    home
      ? sql`UPDATE userPlace SET lat = ${home.lat}, lon = ${home.lon} WHERE id = ${first.id}`
      : sql`DELETE FROM userPlace WHERE id = ${first.id}`,
  );

  await mirrorLegacyHome(conn, userId);
}
