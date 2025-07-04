import { Middleware } from 'koa';
import { createPool } from 'mariadb';
import sql from 'sql-template-tag';
import { getEnv, getEnvInteger } from './env.js';
import { appLogger } from './logger.js';

export const pool = createPool({
  host: getEnv('MARIADB_HOST'),
  port: getEnvInteger('MARIADB_PORT', 3306),
  database: getEnv('MARIADB_DATABASE'),
  user: getEnv('MARIADB_USER'),
  password: getEnv('MARIADB_PASSWORD'),
  bigIntAsNumber: true,
  insertIdAsNumber: true,
  decimalAsNumber: true,
});

const logger = appLogger.child({ module: 'db' });

export async function initDatabase() {
  const scripts = [
    `CREATE TABLE IF NOT EXISTS user (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      osmId INT UNSIGNED NULL UNIQUE,
      facebookUserId VARCHAR(32) CHARSET ascii NULL UNIQUE,
      googleUserId VARCHAR(32) CHARSET ascii NULL UNIQUE,
      garminUserId VARCHAR(60) CHARSET ascii NULL UNIQUE,
      garminAccessToken VARCHAR(255) CHARSET ascii NULL,
      garminAccessTokenSecret VARCHAR(255) CHARSET ascii NULL,
      name VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
      email VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL,
      isAdmin BOOL NOT NULL DEFAULT 0,
      createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      lat FLOAT(8, 6) NULL,
      lon FLOAT(9, 6) NULL,
      settings VARCHAR(4096) CHARSET utf8 COLLATE utf8_bin NOT NULL DEFAULT '{}',
      sendGalleryEmails BOOL NOT NULL DEFAULT 1,
      premiumExpiration TIMESTAMP NULL,
      credits FLOAT NOT NULL DEFAULT 0,
      language CHAR(2) NULL
    ) ENGINE=InnoDB`,

    `CREATE TABLE IF NOT EXISTS blockedCredit (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      amount FLOAT NOT NULL,
      userId INT UNSIGNED NOT NULL,
      createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (userId) REFERENCES user (id) ON DELETE CASCADE
    ) ENGINE=InnoDB`,

    `CREATE TABLE IF NOT EXISTS auth (
      authToken VARCHAR(255) CHARSET ascii PRIMARY KEY,
      userId INT UNSIGNED NOT NULL,
      createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX authTokenIdx (authToken),
      FOREIGN KEY (userId) REFERENCES user (id) ON DELETE CASCADE
    ) ENGINE=InnoDB`,

    `CREATE TABLE IF NOT EXISTS purchaseToken (
      token VARCHAR(255) CHARSET ascii NULL PRIMARY KEY,
      userId INT UNSIGNED NOT NULL,
      createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expireAt TIMESTAMP NOT NULL,
      item JSON NOT NULL,
      FOREIGN KEY (userId) REFERENCES user (id) ON DELETE CASCADE
    ) ENGINE=InnoDB`,

    `CREATE TABLE IF NOT EXISTS purchase (
      userId INT UNSIGNED NOT NULL,
      item JSON NOT NULL,
      createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      note VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL,
      FOREIGN KEY (userId) REFERENCES user (id) ON DELETE CASCADE
    ) ENGINE=InnoDB`,

    `CREATE TABLE IF NOT EXISTS picture (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      pathname VARCHAR(255) CHARSET utf8 COLLATE utf8_bin NOT NULL UNIQUE,
      userId INT UNSIGNED NOT NULL,
      title VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL,
      description VARCHAR(4096) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL,
      takenAt TIMESTAMP NULL,
      createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      lat FLOAT(8, 6) NOT NULL,
      lon FLOAT(9, 6) NOT NULL,
      pano BIT NOT NULL,
      premium BIT NOT NULL DEFAULT FALSE,
      FOREIGN KEY (userId) REFERENCES user (id) ON DELETE CASCADE,
      INDEX picPano (pano),
      INDEX picPremium (premium),
      INDEX picTakenAtIdx USING BTREE (takenAt),
      INDEX picCreatedAtIdx USING BTREE (createdAt),
      INDEX picLatIdx USING BTREE (lat),
      INDEX picLonIdx USING BTREE (lon)
    ) ENGINE=InnoDB`,

    `CREATE TABLE IF NOT EXISTS pictureTag (
      pictureId INT UNSIGNED NOT NULL,
      name VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
      PRIMARY KEY (pictureId, name),
      FOREIGN KEY (pictureId) REFERENCES picture (id) ON DELETE CASCADE,
      INDEX ptNameIdx (name)
    ) ENGINE=InnoDB`,

    `CREATE TABLE IF NOT EXISTS pictureComment (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      pictureId INT UNSIGNED NOT NULL,
      userId INT UNSIGNED NOT NULL,
      createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      comment VARCHAR(4096) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
      FOREIGN KEY (pictureId) REFERENCES picture (id) ON DELETE CASCADE,
      FOREIGN KEY (userId) REFERENCES user (id) ON DELETE CASCADE
    ) ENGINE=InnoDB`,

    `CREATE TABLE IF NOT EXISTS pictureRating (
      userId INT UNSIGNED NOT NULL,
      pictureId INT UNSIGNED NOT NULL,
      stars TINYINT UNSIGNED NOT NULL,
      ratedAt TIMESTAMP NOT NULL,
      PRIMARY KEY (pictureId, userId),
      FOREIGN KEY (pictureId) REFERENCES picture (id) ON DELETE CASCADE,
      FOREIGN KEY (userId) REFERENCES user (id) ON DELETE CASCADE
    ) ENGINE=InnoDB`,

    `CREATE TABLE IF NOT EXISTS trackingDevice (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      userId INT UNSIGNED NOT NULL,
      name VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
      token VARCHAR(255) CHARSET ascii NOT NULL UNIQUE,
      maxCount INT UNSIGNED NULL,
      maxAge INT UNSIGNED NULL,
      createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT tdUserFk FOREIGN KEY (userId) REFERENCES user (id) ON DELETE CASCADE
    ) ENGINE=InnoDB`,

    `CREATE TABLE IF NOT EXISTS trackingPoint (
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

    `CREATE TABLE IF NOT EXISTS trackingAccessToken (
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

    `CREATE TABLE IF NOT EXISTS map (
      id CHAR(8) PRIMARY KEY,
      createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      modifiedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      name VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL,
      userId INT UNSIGNED NOT NULL,
      public BOOL NOT NULL DEFAULT 0,
      data MEDIUMTEXT CHARSET utf8 COLLATE utf8_bin NOT NULL DEFAULT '{}',
      CONSTRAINT umUserFk FOREIGN KEY (userId) REFERENCES user (id) ON DELETE CASCADE,
      INDEX umCreatedAtIdx (createdAt)
    ) ENGINE=InnoDB`,

    `CREATE TABLE IF NOT EXISTS mapWriteAccess (
      mapId CHAR(8) NOT NULL,
      userId INT UNSIGNED NOT NULL,
      PRIMARY KEY (mapId, userId),
      CONSTRAINT mwaUserFk FOREIGN KEY (userId) REFERENCES user (id) ON DELETE CASCADE,
      CONSTRAINT mwaMapFk FOREIGN KEY (mapId) REFERENCES map (id) ON DELETE CASCADE
    ) ENGINE=InnoDB`,
  ];

  const updates: (string | string[])[] = [
    [
      'ALTER TABLE user ADD COLUMN premiumExpiration TIMESTAMP NULL',
      'UPDATE user SET premiumExpiration = (SELECT MAX(expireAt) FROM purchase WHERE userId = user.id)',
      'ALTER TABLE purchase DROP COLUMN expireAt',
      "ALTER TABLE purchase ADD COLUMN item JSON NOT NULL DEFAULT '{}'",
      "UPDATE purchase SET item = JSON_OBJECT('type', 'legacy', 'value', article) WHERE item IS NULL",
      'ALTER TABLE purchase DROP COLUMN article',
    ],
    'ALTER TABLE user ADD COLUMN credits FLOAT NOT NULL DEFAULT 0',
    'RENAME TABLE purchase_token TO purchaseToken',
    'ALTER TABLE purchaseToken ADD COLUMN item JSON NOT NULL',
    'ALTER TABLE purchase ADD COLUMN note VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL',
    'ALTER TABLE picture ADD COLUMN premium BIT NOT NULL DEFAULT FALSE',
    'ALTER TABLE picture ADD COLUMN azimuth FLOAT DEFAULT NULL',
  ];

  const db = await pool.getConnection();

  try {
    for (const script of scripts) {
      await db.query(script);
    }

    await Promise.all(
      updates.map((scripts) =>
        (async () => {
          for (const script of Array.isArray(scripts) ? scripts : [scripts]) {
            try {
              await db.query(script);
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

  async function cleanup() {
    const conn = await pool.getConnection();

    try {
      await conn.query('DELETE FROM purchaseToken WHERE expireAt < NOW()');

      await conn.beginTransaction();

      // TODO track pending downloads taking more than a day :-o

      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);

      const rows = await conn.query(
        sql`SELECT userId, amount FROM blockedCredit WHERE createdAt < ${yesterday} FOR UPDATE`,
      );

      await Promise.all(
        rows.map((row: { userId: number; amount: number }) =>
          conn.query(
            sql`UPDATE user SET credits = credits + ${row.amount} WHERE id = ${row.userId}`,
          ),
        ),
      );

      await conn.query(
        sql`DELETE FROM blockedCredit WHERE createdAt < ${yesterday}`,
      );

      await conn.commit();
    } finally {
      conn.release();
    }
  }

  cleanup();

  // every 1 hour
  setInterval(cleanup, 60_000 * 60 * 1);
}

export function runInTransaction(): Middleware {
  return async (ctx, next) => {
    const conn = await pool.getConnection();

    try {
      await conn.beginTransaction();

      const old = ctx.state.dbConn;

      ctx.state.dbConn = conn;

      await next();

      ctx.state.dbConn = old;

      await conn.commit();
    } finally {
      conn.release();
    }
  };
}
