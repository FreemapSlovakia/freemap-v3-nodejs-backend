import type { PoolConnection } from 'mariadb';
import { createPool } from 'mariadb';
import sql, { raw } from 'sql-template-tag';
import z from 'zod';
import { getEnv, getEnvBoolean, getEnvInteger } from './env.js';
import { appLogger } from './logger.js';
import { USER_COLUMNS_SQL, UserRowSchema } from './types.js';
import { MergeConflictError, mergeUserAccounts } from './userMerge.js';

export const pool = createPool({
  host: getEnv('MARIADB_HOST'),
  port: getEnvInteger('MARIADB_PORT', 3306),
  database: getEnv('MARIADB_DATABASE'),
  user: getEnv('MARIADB_USER'),
  password: getEnv('MARIADB_PASSWORD'),
  connectionLimit: getEnvInteger('MARIADB_CONNECTION_LIMIT', 10),
  bigIntAsNumber: true,
  insertIdAsNumber: true,
  decimalAsNumber: true,
});

const logger = appLogger.child({ module: 'db' });

export async function initDatabase() {
  const scripts = [
    sql`CREATE TABLE IF NOT EXISTS user (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      osmId INT UNSIGNED NULL UNIQUE,
      facebookUserId VARCHAR(32) CHARSET ascii NULL UNIQUE,
      googleUserId VARCHAR(32) CHARSET ascii NULL UNIQUE,
      garminUserId VARCHAR(60) CHARSET ascii NULL UNIQUE,
      garminAccessToken VARCHAR(255) CHARSET ascii NULL,
      garminAccessTokenSecret VARCHAR(255) CHARSET ascii NULL,
      githubUserId VARCHAR(32) CHARSET ascii NULL,
      stravaUserId VARCHAR(32) CHARSET ascii NULL,
      stravaAccessToken VARCHAR(255) CHARSET ascii NULL,
      stravaRefreshToken VARCHAR(255) CHARSET ascii NULL,
      stravaTokenExpiresAt TIMESTAMP NULL,
      microsoftUserId VARCHAR(64) CHARSET ascii NULL,
      name VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
      picture MEDIUMBLOB NULL,
      email VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL,
      description TEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL,
      roles JSON NOT NULL DEFAULT '[]',
      createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      lat FLOAT(8, 6) NULL,
      lon FLOAT(9, 6) NULL,
      settings JSON NOT NULL DEFAULT '{}',
      sendGalleryEmails BIT NOT NULL DEFAULT true,
      premiumExpiration TIMESTAMP NULL,
      credits FLOAT NOT NULL DEFAULT 0,
      language CHAR(2) NULL,
      polarCustomerId VARCHAR(64) CHARSET ascii NULL,
      polarSubscriptionId VARCHAR(64) CHARSET ascii NULL
    ) ENGINE=InnoDB`,

    sql`CREATE TABLE IF NOT EXISTS blockedCredit (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      amount FLOAT NOT NULL,
      userId INT UNSIGNED NOT NULL,
      createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (userId) REFERENCES user (id) ON DELETE CASCADE
    ) ENGINE=InnoDB`,

    sql`CREATE TABLE IF NOT EXISTS auth (
      authToken VARCHAR(255) CHARSET ascii PRIMARY KEY,
      userId INT UNSIGNED NOT NULL,
      createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX authTokenIdx (authToken),
      FOREIGN KEY (userId) REFERENCES user (id) ON DELETE CASCADE
    ) ENGINE=InnoDB`,

    sql`CREATE TABLE IF NOT EXISTS purchaseToken (
      token VARCHAR(255) CHARSET ascii NULL PRIMARY KEY,
      userId INT UNSIGNED NOT NULL,
      createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expireAt TIMESTAMP NOT NULL,
      item JSON NOT NULL,
      FOREIGN KEY (userId) REFERENCES user (id) ON DELETE CASCADE
    ) ENGINE=InnoDB`,

    sql`CREATE TABLE IF NOT EXISTS purchaseIntent (
      token VARCHAR(255) CHARSET ascii NULL PRIMARY KEY,
      userId INT UNSIGNED NOT NULL,
      createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      expireAt TIMESTAMP NOT NULL,
      item JSON NOT NULL,
      status ENUM('created','awaiting_payment','confirmed','rejected') NOT NULL DEFAULT 'created',
      lastEvent VARCHAR(32) CHARSET ascii NULL,
      lastOccurredAt INT UNSIGNED NULL,
      amountPaid INT UNSIGNED NULL,
      currency CHAR(3) CHARSET ascii NULL,
      email VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL,
      bankIntentStatus VARCHAR(32) CHARSET ascii NULL,
      FOREIGN KEY (userId) REFERENCES user (id) ON DELETE CASCADE,
      INDEX piUserIdIdx (userId),
      INDEX piStatusIdx (status),
      INDEX piExpireAtIdx (expireAt)
    ) ENGINE=InnoDB`,

    sql`CREATE TABLE IF NOT EXISTS purchase (
      userId INT UNSIGNED NOT NULL,
      item JSON NOT NULL,
      createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      note VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL,
      polarOrderId VARCHAR(64) CHARSET ascii NULL UNIQUE,
      FOREIGN KEY (userId) REFERENCES user (id) ON DELETE CASCADE
    ) ENGINE=InnoDB`,

    sql`CREATE TABLE IF NOT EXISTS picture (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      pathname VARCHAR(255) CHARSET utf8 COLLATE utf8_bin NOT NULL UNIQUE,
      userId INT UNSIGNED NOT NULL,
      title VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL,
      description VARCHAR(4096) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL,
      takenAt TIMESTAMP NULL,
      createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      location POINT NOT NULL,
      country CHAR(2) CHARSET ascii NULL,
      pano BIT NOT NULL,
      premium BIT NOT NULL DEFAULT FALSE,
      azimuth FLOAT DEFAULT NULL,
      license VARCHAR(32) CHARSET ascii NOT NULL DEFAULT 'CC-BY-SA-4.0',
      FOREIGN KEY (userId) REFERENCES user (id) ON DELETE CASCADE,
      INDEX picPano (pano),
      INDEX picPremium (premium),
      INDEX picTakenAtIdx USING BTREE (takenAt),
      INDEX picCreatedAtIdx USING BTREE (createdAt),
      SPATIAL INDEX picture_location_spx (location)
    ) ENGINE=InnoDB`,

    sql`CREATE TABLE IF NOT EXISTS pictureTag (
      pictureId INT UNSIGNED NOT NULL,
      name VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
      PRIMARY KEY (pictureId, name),
      FOREIGN KEY (pictureId) REFERENCES picture (id) ON DELETE CASCADE,
      INDEX ptNameIdx (name)
    ) ENGINE=InnoDB`,

    sql`CREATE TABLE IF NOT EXISTS pictureComment (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      pictureId INT UNSIGNED NOT NULL,
      userId INT UNSIGNED NOT NULL,
      createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      comment VARCHAR(4096) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
      FOREIGN KEY (pictureId) REFERENCES picture (id) ON DELETE CASCADE,
      FOREIGN KEY (userId) REFERENCES user (id) ON DELETE CASCADE
    ) ENGINE=InnoDB`,

    sql`CREATE TABLE IF NOT EXISTS pictureRating (
      userId INT UNSIGNED NOT NULL,
      pictureId INT UNSIGNED NOT NULL,
      stars TINYINT UNSIGNED NOT NULL,
      ratedAt TIMESTAMP NOT NULL,
      PRIMARY KEY (pictureId, userId),
      FOREIGN KEY (pictureId) REFERENCES picture (id) ON DELETE CASCADE,
      FOREIGN KEY (userId) REFERENCES user (id) ON DELETE CASCADE
    ) ENGINE=InnoDB`,

    // Append-only log of each picture's license over time, so we can prove
    // which license applied when — the latest row is the current license and
    // its changedAt is the "licensed since" shown in the viewer.
    sql`CREATE TABLE IF NOT EXISTS pictureLicenseHistory (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      pictureId INT UNSIGNED NOT NULL,
      license VARCHAR(32) CHARSET ascii NOT NULL,
      changedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (pictureId) REFERENCES picture (id) ON DELETE CASCADE,
      INDEX plhPictureIdx (pictureId, changedAt)
    ) ENGINE=InnoDB`,

    // Geotagged Wikimedia Commons photos, bulk-imported monthly from the Commons
    // `geo_tags` + `page` + `image` + SDC mediainfo dumps (see
    // src/wikimedia/importWikimedia.ts), which atomically swaps in a fresh copy.
    // Created here too so a fresh deploy has the table before the first import
    // runs — otherwise the gallery's Wikimedia arm errors on the missing table.
    // Carries no foreign keys and nothing references it. capturedAt (EXIF
    // DateTimeOriginal, falling back to the SDC P571 inception date), uploadedAt
    // (upload time), authorId (numeric Commons actor id — the name isn't in any
    // public dump), azimuth (EXIF GPSImgDirection) and licenseId (raw Wikidata
    // license item from SDC P275, mapped to a family at query time) back the
    // gallery's date/season/author/license colorizing and the direction markers;
    // the file title, image URL and CC attribution are still fetched by the
    // client straight from the Commons API by pageId when a photo is opened.
    sql`CREATE TABLE IF NOT EXISTS wikimediaPicture (
      pageId INT UNSIGNED NOT NULL PRIMARY KEY,
      location POINT NOT NULL,
      capturedAt DATETIME NULL,
      uploadedAt DATETIME NULL,
      authorId BIGINT UNSIGNED NULL,
      azimuth SMALLINT UNSIGNED NULL,
      licenseId INT UNSIGNED NULL,
      SPATIAL KEY wikimediaPicture_location_spx (location),
      KEY wikimediaPicture_capturedAt (capturedAt),
      KEY wikimediaPicture_uploadedAt (uploadedAt)
    ) ENGINE=InnoDB`,

    // Ratings for Wikimedia photos. Keyed on the stable Commons pageId and kept
    // deliberately independent of `wikimediaPicture` (no FK) so the monthly
    // table swap never disturbs them; ratings whose photo later disappears from
    // Commons simply stop rendering.
    sql`CREATE TABLE IF NOT EXISTS wikimediaRating (
      pageId INT UNSIGNED NOT NULL,
      userId INT UNSIGNED NOT NULL,
      stars TINYINT UNSIGNED NOT NULL,
      ratedAt TIMESTAMP NOT NULL,
      PRIMARY KEY (pageId, userId),
      FOREIGN KEY (userId) REFERENCES user (id) ON DELETE CASCADE
    ) ENGINE=InnoDB`,

    // Comments on Wikimedia photos. Also keyed on the stable Commons pageId and
    // independent of `wikimediaPicture` (see wikimediaRating).
    sql`CREATE TABLE IF NOT EXISTS wikimediaComment (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      pageId INT UNSIGNED NOT NULL,
      userId INT UNSIGNED NOT NULL,
      createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      comment VARCHAR(4096) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
      FOREIGN KEY (userId) REFERENCES user (id) ON DELETE CASCADE,
      INDEX wcPageIdIdx (pageId, createdAt)
    ) ENGINE=InnoDB`,

    sql`CREATE TABLE IF NOT EXISTS trackingDevice (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      userId INT UNSIGNED NOT NULL,
      name VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
      token VARCHAR(255) CHARSET ascii NOT NULL UNIQUE,
      maxCount INT UNSIGNED NULL,
      maxAge INT UNSIGNED NULL,
      createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT tdUserFk FOREIGN KEY (userId) REFERENCES user (id) ON DELETE CASCADE
    ) ENGINE=InnoDB`,

    sql`CREATE TABLE IF NOT EXISTS trackingPoint (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      deviceId INT UNSIGNED NOT NULL,
      createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      lat FLOAT(8, 6) NOT NULL,
      lon FLOAT(9, 6) NOT NULL,
      altitude FLOAT NULL,
      speed FLOAT NULL,
      accuracy FLOAT NULL,
      hdop FLOAT NULL,
      bearing FLOAT NULL,
      battery FLOAT NULL,
      gsmSignal FLOAT NULL,
      message VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL,
      CONSTRAINT tpDeviceIdFk FOREIGN KEY (deviceId) REFERENCES trackingDevice (id) ON DELETE CASCADE,
      INDEX tpCreatedAtIdx (createdAt)
    ) ENGINE=InnoDB`,

    sql`CREATE TABLE IF NOT EXISTS trackingAccessToken (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      deviceId INT UNSIGNED NOT NULL,
      token VARCHAR(255) CHARSET ascii NOT NULL UNIQUE,
      createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      timeFrom TIMESTAMP NULL,
      timeTo TIMESTAMP NULL,
      listingLabel VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL,
      note VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL,
      CONSTRAINT tatDeviceIdFk FOREIGN KEY (deviceId) REFERENCES trackingDevice (id) ON DELETE CASCADE,
      INDEX tatCreatedAtIdx (createdAt)
    ) ENGINE=InnoDB`,

    sql`CREATE TABLE IF NOT EXISTS map (
      id CHAR(8) PRIMARY KEY,
      createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      modifiedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      name VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL,
      userId INT UNSIGNED NOT NULL,
      public BIT NOT NULL DEFAULT false,
      data MEDIUMTEXT CHARSET utf8 COLLATE utf8_bin NOT NULL DEFAULT '{}',
      CONSTRAINT umUserFk FOREIGN KEY (userId) REFERENCES user (id) ON DELETE CASCADE,
      INDEX umCreatedAtIdx (createdAt)
    ) ENGINE=InnoDB`,

    sql`CREATE TABLE IF NOT EXISTS mapWriteAccess (
      mapId CHAR(8) NOT NULL,
      userId INT UNSIGNED NOT NULL,
      PRIMARY KEY (mapId, userId),
      CONSTRAINT mwaUserFk FOREIGN KEY (userId) REFERENCES user (id) ON DELETE CASCADE,
      CONSTRAINT mwaMapFk FOREIGN KEY (mapId) REFERENCES map (id) ON DELETE CASCADE
    ) ENGINE=InnoDB`,

    // CREATE OR REPLACE (not IF NOT EXISTS) so the trigger is recreated on every
    // startup, resetting its DEFINER to the app's current connection user. This
    // self-heals a stale DEFINER (e.g. after restoring the DB onto a new host
    // where the original definer user no longer exists), which otherwise makes
    // every INSERT/UPDATE on `picture` fail with error 1449.
    sql`CREATE OR REPLACE TRIGGER picture_country_bu
      BEFORE UPDATE ON picture
      FOR EACH ROW
      BEGIN
        IF NOT ST_Equals(NEW.location, OLD.location) THEN
          SET NEW.country = (
            SELECT c.alpha2
            FROM \`country\` c
            WHERE MBRContains(c.geom, NEW.location)
              AND ST_Contains(c.geom, NEW.location)
            LIMIT 1
          );
        END IF;
      END`,

    sql`CREATE OR REPLACE TRIGGER picture_country_bi
        BEFORE INSERT ON picture
        FOR EACH ROW
        BEGIN
          IF NEW.location IS NOT NULL THEN
            SET NEW.country = (
              SELECT c.alpha2
              FROM \`country\` c
              WHERE MBRContains(c.geom, NEW.location)
                AND ST_Contains(c.geom, NEW.location)
              LIMIT 1
            );
          END IF;
        END`,
  ];

  const updates: (string | string[])[] = [
    'ALTER TABLE user ADD COLUMN description TEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL',
    'ALTER TABLE user ADD COLUMN appleUserId VARCHAR(255) DEFAULT NULL',
    'CREATE UNIQUE INDEX user_appleUserId ON user(appleUserId)',
    'ALTER TABLE user ADD COLUMN picture MEDIUMBLOB NULL',
    "ALTER TABLE user MODIFY COLUMN settings JSON NOT NULL DEFAULT '{}'",
    'ALTER TABLE user ADD COLUMN githubUserId VARCHAR(32) CHARSET ascii DEFAULT NULL',
    'CREATE UNIQUE INDEX user_githubUserId ON user(githubUserId)',
    'ALTER TABLE user ADD COLUMN stravaUserId VARCHAR(32) CHARSET ascii DEFAULT NULL',
    'CREATE UNIQUE INDEX user_stravaUserId ON user(stravaUserId)',
    'ALTER TABLE user ADD COLUMN microsoftUserId VARCHAR(64) CHARSET ascii DEFAULT NULL',
    'CREATE UNIQUE INDEX user_microsoftUserId ON user(microsoftUserId)',
    'ALTER TABLE user ADD COLUMN stravaAccessToken VARCHAR(255) CHARSET ascii DEFAULT NULL',
    'ALTER TABLE user ADD COLUMN stravaRefreshToken VARCHAR(255) CHARSET ascii DEFAULT NULL',
    'ALTER TABLE user ADD COLUMN stravaTokenExpiresAt TIMESTAMP NULL DEFAULT NULL',
    // Replace the boolean isAdmin flag with a granular roles array. Existing
    // admins gain all roles so their access is unchanged. Sequenced as one
    // entry so backfill runs after the column is added and before it is dropped.
    [
      "ALTER TABLE user ADD COLUMN roles JSON NOT NULL DEFAULT '[]'",
      "UPDATE user SET roles = JSON_ARRAY('userManager', 'galleryModerator', 'mapModerator', 'trackingManager', 'layerPreview') WHERE isAdmin = 1",
      'ALTER TABLE user DROP COLUMN isAdmin',
    ],
    // Polar billing (parallel to the legacy Rovas flow).
    'ALTER TABLE user ADD COLUMN polarCustomerId VARCHAR(64) CHARSET ascii DEFAULT NULL',
    'ALTER TABLE user ADD COLUMN polarSubscriptionId VARCHAR(64) CHARSET ascii DEFAULT NULL',
    'ALTER TABLE purchase ADD COLUMN polarOrderId VARCHAR(64) CHARSET ascii DEFAULT NULL',
    'CREATE UNIQUE INDEX purchase_polarOrderId ON purchase(polarOrderId)',
    // Per-photo license (default backfills every existing row to CC BY-SA 4.0).
    "ALTER TABLE picture ADD COLUMN license VARCHAR(32) CHARSET ascii NOT NULL DEFAULT 'CC-BY-SA-4.0'",
    // Seed the license history for pictures that predate the history table (or
    // the column). Guarded so it only ever inserts the missing rows; retries
    // harmlessly on later boots if the column was not yet present.
    'INSERT INTO pictureLicenseHistory (pictureId, license, changedAt) SELECT id, license, createdAt FROM picture WHERE id NOT IN (SELECT pictureId FROM pictureLicenseHistory)',
  ];

  const db = await pool.getConnection();

  try {
    for (const script of scripts) {
      await db.query<unknown>(script);
    }

    await Promise.all(
      updates.map((scripts) =>
        (async () => {
          for (const script of Array.isArray(scripts) ? scripts : [scripts]) {
            try {
              await db.query<unknown>(script);
            } catch (err) {
              logger.info(`Unsuccessful SQL ${script}: ${err}`);

              return;
            }
          }
        })(),
      ),
    );
  } finally {
    db.release();
  }

  if (getEnvBoolean('ALLOW_EMAIL_ACCOUNT_LINKING', false)) {
    const dedup = await mergeDuplicateUsers();

    if (dedup.merged || dedup.conflicts || dedup.missing) {
      logger.info(
        `User dedup: merged=${dedup.merged}, conflicts=${dedup.conflicts}, missing=${dedup.missing}`,
      );
    }
  }

  async function cleanup() {
    await pool.query<unknown>(
      sql`DELETE FROM purchaseToken WHERE expireAt < NOW()`,
    );

    await pool.query<unknown>(
      sql`DELETE FROM purchaseIntent WHERE expireAt < NOW()`,
    );

    await runInTransaction(async (conn) => {
      // TODO track pending downloads taking more than a day :-o

      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);

      const rows = await conn.query<unknown>(
        sql`SELECT userId, amount FROM blockedCredit WHERE createdAt < ${yesterday} FOR UPDATE`,
      );

      const blockedCredits = z
        .array(z.object({ userId: z.uint32(), amount: z.number() }))
        .parse(rows);

      await Promise.all(
        blockedCredits.map(({ amount, userId }) =>
          conn.query<unknown>(
            sql`UPDATE user SET credits = credits + ${amount} WHERE id = ${userId}`,
          ),
        ),
      );

      await conn.query<unknown>(
        sql`DELETE FROM blockedCredit WHERE createdAt < ${yesterday}`,
      );
    });
  }

  cleanup();

  // every 1 hour
  setInterval(cleanup, 60_000 * 60 * 1);
}

const MAX_ATTEMPTS = 5;
const BASE_DELAY_MS = 50;
const MAX_DELAY_MS = 1500;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withJitter(ms: number) {
  return ms + Math.floor(Math.random() * ms);
}

export function isSqlDuplicateError(err: unknown): boolean {
  return z.object({ errno: z.literal(1062) }).safeParse(err).success;
}

function isRetryableTxError(err: unknown): boolean {
  return z.object({ sqlState: z.literal('40001') }).safeParse(err).success;
}

export async function runInTransaction<T>(
  fn: (conn: PoolConnection) => Promise<T>,
  opts: {
    maxAttempts?: number;
    baseDelay?: number;
    maxDelay?: number;
  } = {},
): Promise<T> {
  const {
    maxAttempts = MAX_ATTEMPTS,
    baseDelay = BASE_DELAY_MS,
    maxDelay = MAX_DELAY_MS,
  } = opts;

  let attempt = 0;

  while (true) {
    const conn = await pool.getConnection();

    try {
      await conn.beginTransaction();

      const res = await fn(conn);

      await conn.commit();

      return res;
    } catch (err: unknown) {
      try {
        await conn.rollback();
      } catch {
        // ignore rollback errors
      }

      if (!isRetryableTxError(err)) {
        throw err;
      }

      attempt++;

      if (attempt >= maxAttempts) {
        throw err;
      }

      const delay = Math.min(
        maxDelay,
        withJitter(baseDelay * 2 ** (attempt - 1)),
      );

      await sleep(delay);
    } finally {
      conn.release();
    }
  }
}

const DuplicateGroupSchema = z.object({
  ids: z
    .string()
    .transform((s) => s.split(',').map((x) => Number.parseInt(x, 10))),
});

/**
 * Merges users that share `(name, email)`. Winner is the oldest by
 * `createdAt`. Each merge runs in its own transaction. Groups with
 * conflicting UNIQUE auth-provider IDs are skipped and counted.
 */
async function mergeDuplicateUsers(): Promise<{
  merged: number;
  conflicts: number;
  missing: number;
}> {
  const rows = await pool.query<unknown[]>(
    sql`SELECT GROUP_CONCAT(id ORDER BY createdAt, id) AS ids
        FROM user
        WHERE email IS NOT NULL
        GROUP BY name, email
        HAVING COUNT(*) > 1`,
  );

  const groups = z
    .array(DuplicateGroupSchema)
    .parse(rows)
    .map((r) => r.ids);

  let merged = 0;
  let conflicts = 0;
  let missing = 0;

  for (const ids of groups) {
    const [targetId, ...sourceIds] = ids;

    for (const sourceId of sourceIds) {
      await runInTransaction(async (conn) => {
        const [tRow] = await conn.query<unknown[]>(
          sql`SELECT ${raw(USER_COLUMNS_SQL)} FROM user WHERE id = ${targetId} FOR UPDATE`,
        );

        const [sRow] = await conn.query<unknown[]>(
          sql`SELECT ${raw(USER_COLUMNS_SQL)} FROM user WHERE id = ${sourceId} FOR UPDATE`,
        );

        if (!tRow || !sRow) {
          missing++;

          return;
        }

        try {
          await mergeUserAccounts(
            conn,
            UserRowSchema.parse(tRow),
            UserRowSchema.parse(sRow),
          );

          logger.info(`Merged user ${sourceId} into ${targetId}`);

          merged++;
        } catch (err) {
          if (err instanceof MergeConflictError) {
            logger.warn(
              `Conflict merging user ${sourceId} into ${targetId}: ${err.column}`,
            );

            conflicts++;

            return;
          }

          throw err;
        }
      });
    }
  }

  return { merged, conflicts, missing };
}
