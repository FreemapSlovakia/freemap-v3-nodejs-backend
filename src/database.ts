import { setTimeout as sleep } from 'node:timers/promises';
import type { PoolConnection } from 'mariadb';
import { createPool } from 'mariadb';
import sql, { join, raw } from 'sql-template-tag';
import z from 'zod';
import { normalizeEmail } from './emailAddress.js';
import { getEnv, getEnvInteger } from './env.js';
import { appLogger } from './logger.js';
import { MIGRATE_HOMES_SQL } from './places.js';

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

// UNIQUE: at most one account has an address verified, so a concurrent second
// verification fails (and its transaction is retried, see isVerifiedEmailTaken).
const VERIFIED_EMAIL_KEY_COLUMN =
  'verifiedEmailKey VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin AS (IF(emailVerified, emailKey, NULL)) PERSISTENT';

// The address mail may go to; mail senders read this, never `email`.
const MAILABLE_EMAIL_COLUMN =
  'mailableEmail VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci AS (IF(emailVerified, email, NULL)) VIRTUAL';

/**
 * Delete a session this long after its last use. Generous because the gallery
 * is used seasonally — a year off between hikes should not sign anyone out.
 */
const SESSION_INACTIVITY_MONTHS = 12;

export async function initDatabase() {
  const scripts = [
    sql`CREATE TABLE IF NOT EXISTS user (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      osmId INT UNSIGNED NULL UNIQUE,
      facebookUserId VARCHAR(32) CHARSET ascii NULL UNIQUE,
      googleUserId VARCHAR(32) CHARSET ascii NULL UNIQUE,
      -- Garmin documents no maximum; observed values are a 36-char dashed
      -- UUID, or a 32-char hex id on older accounts.
      garminUserId VARCHAR(64) CHARSET ascii NULL UNIQUE,
      appleUserId VARCHAR(255) CHARSET ascii NULL UNIQUE,
      -- Only a token granted the write_gpx scope is stored.
      osmAccessToken VARCHAR(255) CHARSET ascii COLLATE ascii_bin NULL,
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
      -- normalizeEmail(email); not UNIQUE, older accounts share addresses.
      emailKey VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
      -- Whether the owner proved receiving mail there; email login needs it.
      emailVerified BIT NOT NULL DEFAULT false,
      ${raw(VERIFIED_EMAIL_KEY_COLUMN)},
      ${raw(MAILABLE_EMAIL_COLUMN)},
      -- Declined being asked for an address (or removed it).
      emailReminderOff BIT NOT NULL DEFAULT false,
      description TEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL,
      roles JSON NOT NULL DEFAULT '[]',
      -- What the public profile may show; see PublicFieldSchema.
      publicFields JSON NOT NULL DEFAULT '[]',
      createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      lat DECIMAL(8, 6) NULL,
      lon DECIMAL(9, 6) NULL,
      settings JSON NOT NULL DEFAULT '{}',
      sendGalleryEmails BIT NOT NULL DEFAULT true,
      sendEventEmails BIT NOT NULL DEFAULT true,
      premiumExpiration TIMESTAMP NULL,
      credits FLOAT NOT NULL DEFAULT 0,
      language CHAR(2) CHARSET ascii NULL,
      polarCustomerId VARCHAR(64) CHARSET ascii NULL,
      polarSubscriptionId VARCHAR(64) CHARSET ascii NULL,
      cancelAtPeriodEnd BIT NOT NULL DEFAULT false,
      -- Whether any account still holds a token, before revoking it.
      INDEX userOsmAccessTokenIdx (osmAccessToken),
      INDEX userEmailKeyIdx (emailKey),
      UNIQUE INDEX userVerifiedEmailKeyIdx (verifiedEmailKey)
    ) ENGINE=InnoDB`,

    // One-time codes proving an address: to log in, or (with userId) to set it
    // as that account's email. Rows outlive expiry for the hourly send limit.
    sql`CREATE TABLE IF NOT EXISTS emailCode (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      purpose ENUM('login', 'change') CHARSET ascii NOT NULL,
      userId INT UNSIGNED NULL,
      email VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
      emailKey VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
      codeHash BINARY(32) NOT NULL,
      -- Whose resend voids this one: the same requester's, not another's.
      requestIp VARCHAR(45) CHARSET ascii NOT NULL DEFAULT '',
      attempts TINYINT UNSIGNED NOT NULL DEFAULT 0,
      createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expireAt TIMESTAMP NOT NULL,
      FOREIGN KEY (userId) REFERENCES user (id) ON DELETE CASCADE,
      INDEX emailCodeKeyIdx (emailKey, createdAt),
      INDEX emailCodeCreatedAtIdx (createdAt)
    ) ENGINE=InnoDB`,

    // The ID of an account merged into another, so its links keep working.
    sql`CREATE TABLE IF NOT EXISTS userAlias (
      oldId INT UNSIGNED PRIMARY KEY,
      userId INT UNSIGNED NOT NULL,
      FOREIGN KEY (userId) REFERENCES user (id) ON DELETE CASCADE
    ) ENGINE=InnoDB`,

    sql`CREATE TABLE IF NOT EXISTS blockedCredit (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      amount FLOAT NOT NULL,
      userId INT UNSIGNED NOT NULL,
      createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (userId) REFERENCES user (id) ON DELETE CASCADE
    ) ENGINE=InnoDB`,

    sql`CREATE TABLE IF NOT EXISTS auth (
      authToken VARCHAR(255) CHARSET ascii COLLATE ascii_bin PRIMARY KEY,
      userId INT UNSIGNED NOT NULL,
      createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      -- Drives session expiry in cleanup(). Refreshed at most hourly by the
      -- authenticator, so it is approximate by design.
      lastUsedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (userId) REFERENCES user (id) ON DELETE CASCADE,
      INDEX authLastUsedIdx (lastUsedAt)
    ) ENGINE=InnoDB`,

    // Only the SHA-256 of the token is kept; it is shown to the user once.
    sql`CREATE TABLE IF NOT EXISTS appToken (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      userId INT UNSIGNED NOT NULL,
      tokenHash BINARY(32) NOT NULL UNIQUE,
      note VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL,
      scopes JSON NOT NULL,
      createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expiresAt TIMESTAMP NULL,
      lastUsedAt TIMESTAMP NULL,
      lastUserAgent VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL,
      FOREIGN KEY (userId) REFERENCES user (id) ON DELETE CASCADE,
      INDEX appTokenExpiresAtIdx (expiresAt)
    ) ENGINE=InnoDB`,

    sql`CREATE TABLE IF NOT EXISTS locusInstall (
      nonce CHAR(43) CHARSET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
      userId INT UNSIGNED NOT NULL,
      expireAt TIMESTAMP NOT NULL,
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
      status ENUM('created','awaiting_payment','confirmed','rejected') CHARSET ascii NOT NULL DEFAULT 'created',
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
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      userId INT UNSIGNED NOT NULL,
      item JSON NOT NULL,
      createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      note VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL,
      polarOrderId VARCHAR(64) CHARSET ascii NULL UNIQUE,
      FOREIGN KEY (userId) REFERENCES user (id) ON DELETE CASCADE
    ) ENGINE=InnoDB`,

    sql`CREATE TABLE IF NOT EXISTS picture (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      pathname VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL UNIQUE,
      userId INT UNSIGNED NOT NULL,
      title VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL,
      description VARCHAR(4096) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL,
      takenAt TIMESTAMP NULL,
      createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      location POINT NOT NULL,
      country CHAR(2) CHARSET ascii NULL,
      pano BIT NOT NULL DEFAULT false,
      premium BIT NOT NULL DEFAULT FALSE,
      azimuth FLOAT DEFAULT NULL,
      license VARCHAR(32) CHARSET ascii NOT NULL DEFAULT 'CC-BY-SA-4.0',
      viewCount INT UNSIGNED NOT NULL DEFAULT 0,
      FOREIGN KEY (userId) REFERENCES user (id) ON DELETE CASCADE,
      INDEX picPano (pano),
      INDEX picPremium (premium),
      INDEX picTakenAtIdx USING BTREE (takenAt),
      INDEX picCreatedAtIdx USING BTREE (createdAt),
      SPATIAL INDEX picture_location_spx (location)
    ) ENGINE=InnoDB`,

    // `labeledAt` once tagLabeler has asked; a tag with no labels then shows
    // its name in every language. `labelAttempts`: its failed asks.
    sql`CREATE TABLE IF NOT EXISTS tag (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL UNIQUE,
      labeledAt TIMESTAMP NULL,
      labelAttempts TINYINT UNSIGNED NOT NULL DEFAULT 0
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    // A tag's broader tags, set by hand; a filter on one finds this tag.
    sql`CREATE TABLE IF NOT EXISTS tagParent (
      tagId INT UNSIGNED NOT NULL,
      parentId INT UNSIGNED NOT NULL,
      PRIMARY KEY (tagId, parentId),
      INDEX tpParentIdx (parentId),
      CONSTRAINT tpTagFk FOREIGN KEY (tagId) REFERENCES tag (id) ON DELETE CASCADE,
      CONSTRAINT tpParentFk FOREIGN KEY (parentId) REFERENCES tag (id) ON DELETE CASCADE
    ) ENGINE=InnoDB`,

    // Only where the label differs from the tag's name.
    sql`CREATE TABLE IF NOT EXISTS tagLabel (
      tagId INT UNSIGNED NOT NULL,
      language CHAR(2) CHARSET ascii NOT NULL,
      label VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
      PRIMARY KEY (tagId, language),
      INDEX tlLabelIdx (label),
      CONSTRAINT tlTagFk FOREIGN KEY (tagId) REFERENCES tag (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    // Other words for a tag, found like its name but never shown as a tag.
    sql`CREATE TABLE IF NOT EXISTS tagSynonym (
      synonym VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL PRIMARY KEY,
      tagId INT UNSIGNED NOT NULL,
      INDEX tsTagIdx (tagId),
      CONSTRAINT tsTagFk FOREIGN KEY (tagId) REFERENCES tag (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    sql`CREATE TABLE IF NOT EXISTS pictureTag (
      pictureId INT UNSIGNED NOT NULL,
      tagId INT UNSIGNED NOT NULL,
      PRIMARY KEY (pictureId, tagId),
      FOREIGN KEY (pictureId) REFERENCES picture (id) ON DELETE CASCADE,
      INDEX ptTagIdx (tagId),
      CONSTRAINT ptTagFk FOREIGN KEY (tagId) REFERENCES tag (id) ON DELETE CASCADE
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
      lat DECIMAL(8, 6) NOT NULL,
      lon DECIMAL(9, 6) NOT NULL,
      altitude FLOAT NULL,
      speed FLOAT NULL,
      accuracy FLOAT NULL,
      hdop FLOAT NULL,
      bearing FLOAT NULL,
      battery FLOAT NULL,
      gsmSignal FLOAT NULL,
      message VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL,
      CONSTRAINT tpDeviceIdFk FOREIGN KEY (deviceId) REFERENCES trackingDevice (id) ON DELETE CASCADE,
      INDEX tpDeviceIdx (deviceId),
      INDEX tpDeviceCreatedAtIdx (deviceId, createdAt)
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
      id CHAR(8) CHARSET ascii PRIMARY KEY,
      createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      modifiedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      name VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL,
      userId INT UNSIGNED NOT NULL,
      data MEDIUMTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL DEFAULT '{}',
      -- The event's own, not listed among its creator's maps; see eventMap.ts.
      -- TODO it still goes with its creator's account (umUserFk), even after
      -- the event was handed to another owner.
      forEvent BIT NOT NULL DEFAULT false,
      CONSTRAINT umUserFk FOREIGN KEY (userId) REFERENCES user (id) ON DELETE CASCADE,
      INDEX umCreatedAtIdx (createdAt)
    ) ENGINE=InnoDB`,

    sql`CREATE TABLE IF NOT EXISTS mapWriteAccess (
      mapId CHAR(8) CHARSET ascii NOT NULL,
      userId INT UNSIGNED NOT NULL,
      PRIMARY KEY (mapId, userId),
      CONSTRAINT mwaUserFk FOREIGN KEY (userId) REFERENCES user (id) ON DELETE CASCADE,
      CONSTRAINT mwaMapFk FOREIGN KEY (mapId) REFERENCES map (id) ON DELETE CASCADE
    ) ENGINE=InnoDB`,

    // Each user's own labels for the maps in their list, seen by nobody else.
    sql`CREATE TABLE IF NOT EXISTS mapTag (
      mapId CHAR(8) CHARSET ascii NOT NULL,
      userId INT UNSIGNED NOT NULL,
      tag VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
      PRIMARY KEY (mapId, userId, tag),
      INDEX mtUserIdx (userId),
      CONSTRAINT mtUserFk FOREIGN KEY (userId) REFERENCES user (id) ON DELETE CASCADE,
      CONSTRAINT mtMapFk FOREIGN KEY (mapId) REFERENCES map (id) ON DELETE CASCADE
    ) ENGINE=InnoDB`,

    // A shared trip. It may link one of its owner's maps, and keeps a snapshot
    // of that map's trip stats for filtering; deleting the map only unlinks it.
    // Lat/lon columns rather than POINT, so a plain index serves the bbox filter.
    sql`CREATE TABLE IF NOT EXISTS event (
      id CHAR(8) CHARSET ascii PRIMARY KEY,
      userId INT UNSIGNED NOT NULL,
      mapId CHAR(8) CHARSET ascii NULL,
      title VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
      description TEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL,
      startAt DATETIME NOT NULL,
      endAt DATETIME NULL,
      -- No time was given: startAt and endAt are UTC midnights of their days.
      dateOnly BIT NOT NULL DEFAULT false,
      startLat DECIMAL(8, 6) NOT NULL,
      startLon DECIMAL(9, 6) NOT NULL,
      -- A harvested event's "<source>:<id there>", which a re-harvest updates by.
      sourceKey VARCHAR(255) CHARSET ascii COLLATE ascii_bin NULL,
      cover VARCHAR(24) CHARSET ascii NULL,
      transports VARCHAR(512) CHARSET ascii NULL,
      difficulty ENUM('easy', 'moderate', 'demanding', 'expert') CHARSET ascii NULL,
      dogs BIT NULL,
      children BIT NULL,
      distance INT UNSIGNED NULL,
      duration INT UNSIGNED NULL,
      ascent INT UNSIGNED NULL,
      descent INT UNSIGNED NULL,
      createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      CONSTRAINT eventUserFk FOREIGN KEY (userId) REFERENCES user (id) ON DELETE CASCADE,
      CONSTRAINT eventMapFk FOREIGN KEY (mapId) REFERENCES map (id) ON DELETE SET NULL,
      UNIQUE INDEX eventSourceKeyIdx (sourceKey),
      INDEX eventTimeIdx (startAt, endAt),
      INDEX eventLocationIdx (startLat, startLon)
    ) ENGINE=InnoDB`,

    sql`CREATE TABLE IF NOT EXISTS eventParticipant (
      eventId CHAR(8) CHARSET ascii NOT NULL,
      userId INT UNSIGNED NOT NULL,
      status ENUM('interested', 'going') CHARSET ascii NOT NULL,
      createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (eventId, userId),
      CONSTRAINT epEventFk FOREIGN KEY (eventId) REFERENCES event (id) ON DELETE CASCADE,
      CONSTRAINT epUserFk FOREIGN KEY (userId) REFERENCES user (id) ON DELETE CASCADE,
      INDEX epUserIdx (userId)
    ) ENGINE=InnoDB`,

    sql`CREATE TABLE IF NOT EXISTS eventComment (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      eventId CHAR(8) CHARSET ascii NOT NULL,
      userId INT UNSIGNED NOT NULL,
      createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      comment VARCHAR(4096) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
      editedAt TIMESTAMP NULL,
      deletedAt TIMESTAMP NULL,
      deletedBy ENUM('author', 'owner', 'moderator') CHARSET ascii NULL,
      CONSTRAINT ecEventFk FOREIGN KEY (eventId) REFERENCES event (id) ON DELETE CASCADE,
      CONSTRAINT ecUserFk FOREIGN KEY (userId) REFERENCES user (id) ON DELETE CASCADE,
      INDEX ecEventIdx (eventId, createdAt)
    ) ENGINE=InnoDB`,

    // Who has had a "going" email sent to the organizer, so toggling Going
    // mails once. Records the send, not its delivery.
    sql`CREATE TABLE IF NOT EXISTS eventGoingNotified (
      eventId CHAR(8) CHARSET ascii NOT NULL,
      userId INT UNSIGNED NOT NULL,
      PRIMARY KEY (eventId, userId),
      CONSTRAINT egnEventFk FOREIGN KEY (eventId) REFERENCES event (id) ON DELETE CASCADE,
      CONSTRAINT egnUserFk FOREIGN KEY (userId) REFERENCES user (id) ON DELETE CASCADE
    ) ENGINE=InnoDB`,

    // A user's named events filters; `notify` emails events coming to match.
    sql`CREATE TABLE IF NOT EXISTS eventFilter (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      userId INT UNSIGNED NOT NULL,
      name VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
      filter JSON NOT NULL,
      notify BOOLEAN NOT NULL DEFAULT FALSE,
      createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      -- Only events coming to match since are emailed; set as the conditions
      -- change or the emails are turned on, not by a rename.
      matchSince TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      -- When the mail job last moved every filter's period (its local day
      -- counts); before matchSince, matchSince stands for it.
      matchedUntil TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT efUserFk FOREIGN KEY (userId) REFERENCES user (id) ON DELETE CASCADE,
      INDEX efNotifyIdx (notify)
    ) ENGINE=InnoDB`,

    // A user's named places; the first is mirrored to `user.lat`/`lon`, the
    // legacy home (see places.ts).
    sql`CREATE TABLE IF NOT EXISTS userPlace (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      userId INT UNSIGNED NOT NULL,
      name VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
      lat DECIMAL(8, 6) NOT NULL,
      lon DECIMAL(9, 6) NOT NULL,
      createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT upUserFk FOREIGN KEY (userId) REFERENCES user (id) ON DELETE CASCADE
    ) ENGINE=InnoDB`,

    // A saved filter's matches, queued for its email; `sentAt` once mailed,
    // kept a while so a later pass doesn't mail them again.
    sql`CREATE TABLE IF NOT EXISTS eventFilterMatch (
      filterId INT UNSIGNED NOT NULL,
      eventId CHAR(8) CHARSET ascii NOT NULL,
      createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      sentAt TIMESTAMP NULL,
      PRIMARY KEY (filterId, eventId),
      CONSTRAINT efmFilterFk FOREIGN KEY (filterId) REFERENCES eventFilter (id) ON DELETE CASCADE,
      CONSTRAINT efmEventFk FOREIGN KEY (eventId) REFERENCES event (id) ON DELETE CASCADE,
      INDEX efmSentIdx (sentAt)
    ) ENGINE=InnoDB`,

    // Who follows or has muted the emails about one event or photo; no row
    // leaves it to whether the user takes part. No FK: the target is one of
    // three tables, so their deletes clear these rows.
    sql`CREATE TABLE IF NOT EXISTS mailWatch (
      userId INT UNSIGNED NOT NULL,
      target ENUM('event', 'picture', 'wikimedia') CHARSET ascii NOT NULL,
      targetId VARCHAR(16) CHARSET ascii NOT NULL,
      watching BIT NOT NULL,
      PRIMARY KEY (userId, target, targetId),
      CONSTRAINT mwUserFk FOREIGN KEY (userId) REFERENCES user (id) ON DELETE CASCADE,
      INDEX mwTargetIdx (target, targetId)
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

  // Schema changes for databases created before the CREATE TABLEs above were
  // last changed. Failures are logged and ignored, so an already applied step
  // is harmless — but note that MODIFY COLUMN rebuilds the whole table every
  // time it runs, so drop these entries once they have been applied everywhere
  // (as commit 6d2fe75 did with the previous batch).
  const updates: (string | string[])[] = [
    // Redundant: authToken is already the PRIMARY KEY.
    'ALTER TABLE auth DROP INDEX IF EXISTS authTokenIdx',

    // The table had no PRIMARY KEY at all.
    'ALTER TABLE purchase ADD COLUMN IF NOT EXISTS id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY FIRST',

    // utf8 is utf8mb3, so saving a map containing an emoji failed with
    // "Incorrect string value" under STRICT_TRANS_TABLES.
    "ALTER TABLE map MODIFY COLUMN data MEDIUMTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL DEFAULT '{}'",
    'ALTER TABLE picture MODIFY COLUMN pathname VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL',

    // FLOAT is single precision and cannot hold the 8 significant digits a
    // coordinate needs; 48.123456 came back as 48.123455 (~11 cm off).
    'ALTER TABLE user MODIFY COLUMN lat DECIMAL(8, 6) NULL, MODIFY COLUMN lon DECIMAL(9, 6) NULL',
    'ALTER TABLE trackingPoint MODIFY COLUMN lat DECIMAL(8, 6) NOT NULL, MODIFY COLUMN lon DECIMAL(9, 6) NOT NULL',

    // Pin the charset of the columns that used to inherit the server default,
    // so every database ends up with the same schema.
    'ALTER TABLE user MODIFY COLUMN language CHAR(2) CHARSET ascii NULL',
    "ALTER TABLE purchaseIntent MODIFY COLUMN status ENUM('created','awaiting_payment','confirmed','rejected') CHARSET ascii NOT NULL DEFAULT 'created'",

    // Distinguishes a subscription still set to auto-renew from one the
    // customer already canceled (access continues either way until
    // `premiumExpiration`, so that alone can't tell them apart).
    'ALTER TABLE user ADD COLUMN cancelAtPeriodEnd BIT NOT NULL DEFAULT false',

    // Nullable in databases predating the NOT NULL above; no NULLs exist and
    // both columns have a foreign key to `user`. The priciest entries here —
    // `picture` is ~700k rows — so prune them once applied everywhere.
    'ALTER TABLE picture MODIFY COLUMN userId INT UNSIGNED NOT NULL',
    'ALTER TABLE auth MODIFY COLUMN userId INT UNSIGNED NOT NULL',

    // Older tables still default to utf8mb3, so a column added without an
    // explicit CHARACTER SET silently inherits it — the trap that made
    // `map.data` reject emoji. Retargets the default only; existing columns
    // are converted below. Deliberately not CONVERT TO CHARACTER SET, which
    // would also rewrite the columns pinned to `ascii` (map.id,
    // picture.license, the OAuth ids) and break the charset match that the
    // map.id / mapWriteAccess.mapId foreign key needs.
    ...[
      'auth',
      'map',
      'picture',
      'pictureComment',
      'pictureRating',
      'pictureTag',
      'trackingAccessToken',
      'trackingDevice',
      'trackingPoint',
      'user',
    ].map((table) => `ALTER TABLE ${table} DEFAULT CHARACTER SET utf8mb4`),

    // Columns that inherited utf8mb3 from those defaults, one statement per
    // table. Checked first: no value in a narrowed column holds a non-ASCII
    // byte.
    'ALTER TABLE map MODIFY COLUMN name VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL',
    'ALTER TABLE trackingAccessToken MODIFY COLUMN listingLabel VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL, MODIFY COLUMN note VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL',
    'ALTER TABLE trackingDevice MODIFY COLUMN name VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL',
    'ALTER TABLE trackingPoint MODIFY COLUMN message VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL',
    'ALTER TABLE picture MODIFY COLUMN title VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL, MODIFY COLUMN country CHAR(2) CHARSET ascii NULL',
    'ALTER TABLE user MODIFY COLUMN email VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL, MODIFY COLUMN appleUserId VARCHAR(255) CHARSET ascii NULL, MODIFY COLUMN facebookUserId VARCHAR(32) CHARSET ascii NULL, MODIFY COLUMN googleUserId VARCHAR(32) CHARSET ascii NULL',

    // utf8mb3_bin in older databases: narrows the charset while keeping the
    // case-sensitive comparison. See the CREATE TABLE above.
    'ALTER TABLE auth MODIFY COLUMN authToken VARCHAR(255) CHARSET ascii COLLATE ascii_bin NOT NULL',

    // Held only Panoramio/Picasa ids from the 2016 imports; both services are
    // gone and nothing read the column. Not IF EXISTS on purpose — the plain
    // form fails once applied, so it stops rebuilding the table every startup.
    'ALTER TABLE picture DROP COLUMN hiddenNote',

    // Long-expired Facebook access tokens from the old login flow, unread by
    // any code. Credential material tied to a user is not worth retaining.
    'ALTER TABLE auth DROP COLUMN facebookAccessToken',

    // Every caller sets `item`, so DEFAULT '{}' only means a bad insert
    // records an empty purchase instead of failing. Billing data should
    // fail loudly.
    'ALTER TABLE purchase ALTER COLUMN item DROP DEFAULT',

    // Drops a legacy ON UPDATE current_timestamp() that silently restamps a
    // rating on any UPDATE. wikimediaRating.ratedAt never had it.
    'ALTER TABLE pictureRating MODIFY COLUMN ratedAt TIMESTAMP NOT NULL',

    // Existing rows get the time of this ALTER, not their createdAt: sessions
    // are only expired once observed unused, so nobody is logged out by the
    // migration itself and the first cleanup can delete nothing until the
    // inactivity window has actually elapsed.
    'ALTER TABLE auth ADD COLUMN lastUsedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, ADD INDEX authLastUsedIdx (lastUsedAt)',

    // Pruning a device's points needs (deviceId, createdAt) for the age limit
    // and (deviceId) for the id order of the count limit; without them it
    // scans the device's whole history. The FK's implicit index, if any, is
    // replaced by the named one so every database matches the CREATE TABLE.
    // Every createdAt filter also has a deviceId, so the createdAt-only index
    // goes.
    'ALTER TABLE trackingPoint ADD INDEX IF NOT EXISTS tpDeviceIdx (deviceId), ADD INDEX IF NOT EXISTS tpDeviceCreatedAtIdx (deviceId, createdAt), DROP INDEX IF EXISTS tpDeviceIdFk, DROP INDEX IF EXISTS tpCreatedAtIdx',

    'ALTER TABLE user ADD COLUMN IF NOT EXISTS osmAccessToken VARCHAR(255) CHARSET ascii COLLATE ascii_bin NULL AFTER appleUserId, ADD INDEX IF NOT EXISTS userOsmAccessTokenIdx (osmAccessToken)',

    // Every map is readable by its link.
    'ALTER TABLE map DROP COLUMN IF EXISTS public',

    "ALTER TABLE user ADD COLUMN IF NOT EXISTS publicFields JSON NOT NULL DEFAULT '[]' AFTER roles",

    // Existing addresses start unproven; a login whose provider vouches for the
    // same one proves it.
    [
      'ALTER TABLE user ADD COLUMN IF NOT EXISTS emailKey VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL AFTER email, ADD COLUMN IF NOT EXISTS emailVerified BIT NOT NULL DEFAULT false AFTER emailKey, ADD INDEX IF NOT EXISTS userEmailKeyIdx (emailKey)',
      // Plain ADD COLUMN: fails once applied, so the index isn't rebuilt.
      `ALTER TABLE user ADD COLUMN ${VERIFIED_EMAIL_KEY_COLUMN} AFTER emailVerified, ADD COLUMN ${MAILABLE_EMAIL_COLUMN} AFTER verifiedEmailKey, ADD UNIQUE INDEX userVerifiedEmailKeyIdx (verifiedEmailKey)`,
    ],

    'ALTER TABLE user ADD COLUMN IF NOT EXISTS emailReminderOff BIT NOT NULL DEFAULT false',

    "ALTER TABLE emailCode ADD COLUMN IF NOT EXISTS requestIp VARCHAR(45) CHARSET ascii NOT NULL DEFAULT '' AFTER codeHash",

    'ALTER TABLE event ADD COLUMN IF NOT EXISTS dateOnly BIT NOT NULL DEFAULT false AFTER endAt, ADD COLUMN IF NOT EXISTS sourceKey VARCHAR(255) CHARSET ascii COLLATE ascii_bin NULL AFTER startLon, ADD UNIQUE INDEX IF NOT EXISTS eventSourceKeyIdx (sourceKey)',

    // Every event is public.
    'ALTER TABLE event DROP COLUMN IF EXISTS visibility',

    'ALTER TABLE picture ADD COLUMN IF NOT EXISTS viewCount INT UNSIGNED NOT NULL DEFAULT 0',

    'ALTER TABLE user ADD COLUMN IF NOT EXISTS sendEventEmails BIT NOT NULL DEFAULT true AFTER sendGalleryEmails',

    // Those going before the table existed were announced already; only while
    // it is empty, so later skipped sends stay unrecorded.
    "INSERT IGNORE INTO eventGoingNotified (eventId, userId) SELECT eventId, userId FROM eventParticipant WHERE status = 'going' AND NOT EXISTS (SELECT 1 FROM eventGoingNotified)",

    ...['pictureComment', 'wikimediaComment', 'eventComment'].map(
      (table) =>
        `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS editedAt TIMESTAMP NULL, ADD COLUMN IF NOT EXISTS deletedAt TIMESTAMP NULL, ADD COLUMN IF NOT EXISTS deletedBy ENUM('author', 'owner', 'moderator') CHARSET ascii NULL`,
    ),

    'ALTER TABLE eventFilter ADD COLUMN IF NOT EXISTS matchSince TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP',

    // Set to now for existing filters: what entered their period before was
    // never promised by email.
    'ALTER TABLE eventFilter ADD COLUMN IF NOT EXISTS matchedUntil TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP',

    // The saved filters' mail reads the last day's events every minute.
    'ALTER TABLE event ADD INDEX IF NOT EXISTS eventCreatedIdx (createdAt)',

    'ALTER TABLE map ADD COLUMN IF NOT EXISTS forEvent BIT NOT NULL DEFAULT false AFTER data',

    // Home locations into places; see places.ts.
    MIGRATE_HOMES_SQL,

    // Tag names into `tag`. The first step fails once `pictureTag.name` is
    // gone, which ends the chain. Marked labeled: their labels are imported
    // separately, not asked of tagLabeler.
    [
      'INSERT INTO tag (name, labeledAt) SELECT name, NOW() FROM pictureTag GROUP BY name ON DUPLICATE KEY UPDATE id = id',
      'ALTER TABLE pictureTag ADD COLUMN IF NOT EXISTS tagId INT UNSIGNED NULL AFTER pictureId',
      'UPDATE pictureTag pt JOIN tag t ON t.name = pt.name SET pt.tagId = t.id',
      'ALTER TABLE pictureTag DROP PRIMARY KEY, DROP INDEX ptNameIdx, DROP COLUMN name, MODIFY COLUMN tagId INT UNSIGNED NOT NULL, ADD PRIMARY KEY (pictureId, tagId), ADD INDEX ptTagIdx (tagId), ADD CONSTRAINT ptTagFk FOREIGN KEY (tagId) REFERENCES tag (id) ON DELETE CASCADE',
    ],

    // `tag.parentId` into `tagParent`; ends once the column is gone.
    [
      'INSERT IGNORE INTO tagParent (tagId, parentId) SELECT id, parentId FROM tag WHERE parentId IS NOT NULL',
      'ALTER TABLE tag DROP FOREIGN KEY IF EXISTS tagParentFk, DROP COLUMN IF EXISTS parentId',
    ],
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

  await backfillEmailKeys();

  async function cleanup() {
    await pool.query<unknown>(
      sql`DELETE FROM purchaseToken WHERE expireAt < NOW()`,
    );

    await pool.query<unknown>(
      sql`DELETE FROM purchaseIntent WHERE expireAt < NOW()`,
    );

    await pool.query<unknown>(
      sql`DELETE FROM appToken WHERE expiresAt < NOW()`,
    );

    await pool.query<unknown>(
      sql`DELETE FROM locusInstall WHERE expireAt < NOW()`,
    );

    await pool.query<unknown>(
      sql`DELETE FROM emailCode WHERE createdAt < NOW() - INTERVAL 1 DAY`,
    );

    // An event's own map is linked as the event is saved; one left unlinked a
    // week by a save that failed and was never retried is nobody's to find.
    await pool.query<unknown>(
      sql`DELETE FROM map WHERE forEvent AND createdAt < NOW() - INTERVAL 7 DAY
        AND NOT EXISTS (SELECT 1 FROM event WHERE mapId = map.id)`,
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

    // Last, so a failure here can't hold up the credit refunds above. By
    // inactivity, not age: a client that keeps its token (the mobile app)
    // would otherwise be logged out despite daily use.
    await pool.query<unknown>(
      sql`DELETE FROM auth WHERE lastUsedAt < NOW() - INTERVAL ${raw(String(SESSION_INACTIVITY_MONTHS))} MONTH`,
    );
  }

  cleanup();

  // every 1 hour
  setInterval(cleanup, 60_000 * 60 * 1);
}

const MAX_ATTEMPTS = 5;
const BASE_DELAY_MS = 50;
const MAX_DELAY_MS = 1500;

function withJitter(ms: number) {
  return ms + Math.floor(Math.random() * ms);
}

export function isSqlDuplicateError(err: unknown): boolean {
  return z.object({ errno: z.literal(1062) }).safeParse(err).success;
}

function isRetryableTxError(err: unknown): boolean {
  return z.object({ sqlState: z.literal('40001') }).safeParse(err).success;
}

/**
 * Another transaction verified the address first. For `retryOn` in the
 * transactions that verify one: a retry reads that account.
 */
export function isVerifiedEmailTaken(err: unknown): boolean {
  return z
    .object({
      errno: z.literal(1062),
      sqlMessage: z.string().includes('userVerifiedEmailKeyIdx'),
    })
    .safeParse(err).success;
}

const commitHooks = new WeakMap<PoolConnection, (() => void)[]>();

/**
 * Runs `fn` once the transaction on `conn` commits, or never if it rolls back.
 * Outside `runInTransaction`, runs it at once.
 */
export function afterCommit(conn: PoolConnection, fn: () => void) {
  const hooks = commitHooks.get(conn);

  if (hooks) {
    hooks.push(fn);
  } else {
    fn();
  }
}

export async function runInTransaction<T>(
  fn: (conn: PoolConnection) => Promise<T>,
  opts: {
    maxAttempts?: number;
    baseDelay?: number;
    maxDelay?: number;
    /** More errors a retry can resolve, besides deadlocks. */
    retryOn?: (err: unknown) => boolean;
  } = {},
): Promise<T> {
  const {
    maxAttempts = MAX_ATTEMPTS,
    baseDelay = BASE_DELAY_MS,
    maxDelay = MAX_DELAY_MS,
    retryOn,
  } = opts;

  let attempt = 0;

  while (true) {
    const conn = await pool.getConnection();

    const hooks: (() => void)[] = [];

    commitHooks.set(conn, hooks);

    try {
      await conn.beginTransaction();

      const res = await fn(conn);

      await conn.commit();

      commitHooks.delete(conn);

      // A throw must not reach the catch, which would run the transaction again.
      for (const hook of hooks) {
        try {
          hook();
        } catch (err) {
          logger.error({ err }, 'after-commit hook failed');
        }
      }

      return res;
    } catch (err: unknown) {
      commitHooks.delete(conn);

      try {
        await conn.rollback();
      } catch {
        // ignore rollback errors
      }

      if (!isRetryableTxError(err) && !retryOn?.(err)) {
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

/** Keys the addresses stored before `emailKey` existed; a no-op afterwards. */
async function backfillEmailKeys() {
  const rows = z
    .array(z.object({ id: z.uint32(), email: z.string() }))
    .parse(
      await pool.query<unknown[]>(
        sql`SELECT id, email FROM user WHERE email IS NOT NULL AND emailKey IS NULL`,
      ),
    );

  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);

    await pool.query<unknown>(
      sql`UPDATE user SET emailKey = CASE id ${join(
        chunk.map(
          ({ id, email }) => sql`WHEN ${id} THEN ${normalizeEmail(email)}`,
        ),
        ' ',
      )} END WHERE id IN (${join(chunk.map(({ id }) => id))})`,
    );
  }

  if (rows.length > 0) {
    logger.info(`Keyed ${rows.length} stored email addresses.`);
  }
}
