import type { PoolConnection } from 'mariadb';
import sql, { empty, join, raw } from 'sql-template-tag';
import type { UserRow } from './types.js';

const PROVIDER_COLS = [
  'osmId',
  'facebookUserId',
  'googleUserId',
  'garminUserId',
  'appleUserId',
] as const;

const SOURCE_AUTH_COLS = [
  'garminUserId',
  'garminAccessToken',
  'garminAccessTokenSecret',
  'osmId',
  'facebookUserId',
  'googleUserId',
  'appleUserId',
] as const;

const SIMPLE_FK_TABLES = [
  'picture',
  'pictureComment',
  'trackingDevice',
  'map',
  'purchase',
  'purchaseToken',
  'purchaseIntent',
  'blockedCredit',
] as const;

// Tables whose PK contains userId — winner may already have a row for the
// same parent (picture / map), so UPDATE IGNORE + DELETE handles collisions.
const COMPOSITE_PK_TABLES = ['pictureRating', 'mapWriteAccess'] as const;

export class MergeConflictError extends Error {
  constructor(public readonly column: (typeof PROVIDER_COLS)[number]) {
    super(`conflicting ${column}`);
    this.name = 'MergeConflictError';
  }
}

/**
 * Merges `source` into `target`. Both rows must already be locked FOR UPDATE
 * by the caller, inside a transaction. After this call, `source` is gone and
 * `target` holds the consolidated row.
 *
 * Throws `MergeConflictError` if both rows have distinct non-null values for
 * the same UNIQUE auth-provider column.
 */
export async function mergeUserAccounts(
  conn: PoolConnection,
  target: UserRow,
  source: UserRow,
  opts: {
    /** Extra columns to write onto `target` (e.g. a new provider ID being
     * connected during a login flow). Applied via COALESCE alongside the
     * source's auth columns. */
    extraTargetFields?: Record<string, unknown>;
    /** A freshly-fetched OAuth picture to use as a higher-priority fallback
     * than the source's stored picture. */
    newPicture?: Buffer | null;
  } = {},
): Promise<void> {
  for (const col of PROVIDER_COLS) {
    if (target[col] && source[col] && target[col] !== source[col]) {
      throw new MergeConflictError(col);
    }
  }

  const authData: Record<string, unknown> = {};

  for (const col of SOURCE_AUTH_COLS) {
    authData[col] = source[col];
  }

  Object.assign(authData, opts.extraTargetFields ?? {});

  await conn.query<unknown>(sql`DELETE FROM auth WHERE userId = ${source.id}`);

  for (const table of SIMPLE_FK_TABLES) {
    await conn.query<unknown>(
      sql`UPDATE ${raw(table)} SET userId = ${target.id} WHERE userId = ${source.id}`,
    );
  }

  for (const table of COMPOSITE_PK_TABLES) {
    await conn.query<unknown>(
      sql`UPDATE IGNORE ${raw(table)} SET userId = ${target.id} WHERE userId = ${source.id}`,
    );

    await conn.query<unknown>(
      sql`DELETE FROM ${raw(table)} WHERE userId = ${source.id}`,
    );
  }

  // Free source's UNIQUE auth-provider IDs before the consolidating UPDATE,
  // otherwise transferring them to target would briefly duplicate the value
  // and trip the UNIQUE constraint. Values are already captured in authData.
  await conn.query<unknown>(sql`UPDATE user SET ${join(
    PROVIDER_COLS.map((c) => sql`${raw(c)} = NULL`),
  )} WHERE id = ${source.id}`);

  const mergedSettings = JSON.stringify({
    ...source.settings,
    ...target.settings,
  });

  const {
    id: sourceId,
    email,
    coordinates,
    language,
    createdAt,
    isAdmin,
    sendGalleryEmails,
    premiumExpiration,
    credits,
  } = source;

  await conn.query<unknown>(sql`
    UPDATE user SET
      email = COALESCE(email, ${email}),
      lat = COALESCE(lat, ${coordinates?.lat}),
      lon = COALESCE(lon, ${coordinates?.lon}),
      language = COALESCE(language, ${language}),
      createdAt = LEAST(createdAt, ${createdAt}),
      isAdmin = isAdmin OR ${isAdmin},
      ${premiumExpiration ? sql`premiumExpiration = COALESCE(GREATEST(premiumExpiration, ${premiumExpiration}), ${premiumExpiration}),` : empty}
      sendGalleryEmails = sendGalleryEmails OR ${sendGalleryEmails},
      settings = ${mergedSettings},
      credits = credits + ${credits},
      picture = COALESCE(picture, ${opts.newPicture ?? null}, (SELECT picture FROM (SELECT picture FROM user WHERE id = ${sourceId}) t)),
      ${join(
        Object.entries(authData).map(
          ([column, value]) =>
            sql`${raw(column)} = COALESCE(${raw(column)}, ${value})`,
        ),
      )}
    WHERE id = ${target.id}
  `);

  await conn.query<unknown>(sql`DELETE FROM user WHERE id = ${source.id}`);
}
