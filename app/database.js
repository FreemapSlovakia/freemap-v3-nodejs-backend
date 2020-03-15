const config = require('config');
const { createPool } = require('mariadb');

const logger = require('~/logger');

const pool = createPool(config.get('mysql'));

async function initDatabase() {
  const scripts = [
    `CREATE TABLE IF NOT EXISTS user (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      osmId INT UNSIGNED NULL UNIQUE,
      facebookUserId VARCHAR(32) CHARSET latin1 COLLATE latin1_bin NULL UNIQUE,
      googleUserId VARCHAR(32) CHARSET latin1 COLLATE latin1_bin NULL UNIQUE,
      name VARCHAR(255) CHARSET utf8 COLLATE utf8_general_ci NOT NULL,
      email VARCHAR(255) CHARSET utf8 COLLATE utf8_general_ci NULL,
      isAdmin BOOL NOT NULL DEFAULT 0,
      createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      lat FLOAT(8, 6) NULL,
      lon FLOAT(9, 6) NULL,
      settings VARCHAR(4096) CHARSET utf8 COLLATE utf8_bin NOT NULL DEFAULT '{}',
      preventTips BOOL NOT NULL DEFAULT 0
    ) ENGINE=InnoDB`,

    `CREATE TABLE IF NOT EXISTS auth (
      authToken VARCHAR(255) CHARSET utf8 COLLATE utf8_bin PRIMARY KEY,
      userId INT UNSIGNED NOT NULL,
      createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      osmAuthToken VARCHAR(255) CHARSET latin1 COLLATE latin1_bin NULL UNIQUE,
      osmAuthTokenSecret VARCHAR(255) CHARSET latin1 COLLATE latin1_bin NULL,
      facebookAccessToken VARCHAR(255) CHARSET latin1 COLLATE latin1_bin NULL,
      googleIdToken VARCHAR(4095) CHARSET latin1 COLLATE latin1_bin NULL,
      FOREIGN KEY (userId) REFERENCES user (id) ON DELETE CASCADE
    ) ENGINE=InnoDB`,

    `CREATE TABLE IF NOT EXISTS picture (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      pathname VARCHAR(255) CHARSET utf8 COLLATE utf8_bin NOT NULL UNIQUE,
      userId INT UNSIGNED NOT NULL,
      title VARCHAR(255) CHARSET utf8 COLLATE utf8_general_ci NULL,
      description VARCHAR(4096) CHARSET utf8 COLLATE utf8_general_ci NULL,
      takenAt TIMESTAMP NULL,
      createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      lat FLOAT(8, 6) NOT NULL,
      lon FLOAT(9, 6) NOT NULL,
      FOREIGN KEY (userId) REFERENCES user (id) ON DELETE CASCADE,
      INDEX USING BTREE (lat),
      INDEX USING BTREE (lon)
    ) ENGINE=InnoDB`,

    `CREATE TABLE IF NOT EXISTS pictureTag (
      pictureId INT UNSIGNED NOT NULL,
      name VARCHAR(255) CHARSET utf8 COLLATE utf8_general_ci,
      PRIMARY KEY (pictureId, name),
      FOREIGN KEY (pictureId) REFERENCES picture (id) ON DELETE CASCADE
    ) ENGINE=InnoDB`,

    `CREATE TABLE IF NOT EXISTS pictureComment (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      pictureId INT UNSIGNED NOT NULL,
      userId INT UNSIGNED NOT NULL,
      createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      comment VARCHAR(4096) CHARSET utf8 COLLATE utf8_general_ci,
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
      name VARCHAR(255) CHARSET utf8 COLLATE utf8_general_ci NOT NULL,
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
      message VARCHAR(255) CHARSET utf8 COLLATE utf8_general_ci NULL,
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
      listingLabel VARCHAR(255) CHARSET utf8 COLLATE utf8_general_ci NULL,
      note VARCHAR(255) CHARSET utf8 COLLATE utf8_general_ci NULL,
      CONSTRAINT tatDeviceIdFk FOREIGN KEY (deviceId) REFERENCES trackingDevice (id) ON DELETE CASCADE,
      INDEX tatCreatedAtIdx (createdAt)
    ) ENGINE=InnoDB`,

    `CREATE TABLE IF NOT EXISTS map (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      name VARCHAR(255) CHARSET utf8 COLLATE utf8_general_ci NULL,
      userId INT UNSIGNED NOT NULL,
      public BOOL NOT NULL DEFAULT 0,
      data MEDIUMTEXT CHARSET utf8 COLLATE utf8_bin NOT NULL DEFAULT '{}',
      CONSTRAINT umUserFk FOREIGN KEY (userId) REFERENCES user (id) ON DELETE CASCADE,
      INDEX umCreatedAtIdx (createdAt)
    ) ENGINE=InnoDB`,
  ];

  const updates = [];

  const db = await pool.getConnection();

  try {
    for (const script of scripts) {
      await db.query(script);
    }

    for (const script of updates) {
      try {
        await db.query(script);
      } catch (err) {
        logger.info(`Unsuccessful SQL ${script}: ${err.message}`);
      }
    }
  } finally {
    db.release();
  }
}

function runInTransaction() {
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

module.exports = { pool, initDatabase, runInTransaction };
