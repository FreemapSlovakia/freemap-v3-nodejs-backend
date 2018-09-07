const config = require('config');
const mysql = require('promise-mysql');

const logger = require('~/logger');

const pool = mysql.createPool(config.get('mysql'));

async function dbMiddleware(ctx, next) {
  const db = await pool.getConnection();
  ctx.state.db = db;
  try {
    await next();
  } finally {
    pool.releaseConnection(db);
  }
}

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
      lat FLOAT(8, 6) NULL,
      lon FLOAT(9, 6) NULL,
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
  ];

  const updates = [
  ];

  const db = await pool.getConnection();
  try {
    /* eslint-disable no-await-in-loop, no-restricted-syntax */
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
    pool.releaseConnection(db);
  }
}

module.exports = { pool, dbMiddleware, initDatabase };
