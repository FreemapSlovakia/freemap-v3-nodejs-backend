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
      osmId INT UNSIGNED NOT NULL UNIQUE,
      name VARCHAR(255) CHARSET utf8 COLLATE utf8_general_ci UNIQUE NOT NULL,
      createdAt TIMESTAMP NOT NULL
    ) ENGINE=InnoDB`,

    `CREATE TABLE IF NOT EXISTS auth (
      authToken VARCHAR(255) CHARSET utf8 COLLATE utf8_bin PRIMARY KEY,
      userId INT UNSIGNED NOT NULL,
      createdAt TIMESTAMP NOT NULL,
      osmAuthToken VARCHAR(255) CHARSET utf8 COLLATE utf8_bin NULL UNIQUE,
      osmAuthTokenSecret VARCHAR(255) CHARSET utf8 COLLATE utf8_bin NULL,
      FOREIGN KEY (userId) REFERENCES user (id) ON DELETE CASCADE
    ) ENGINE=InnoDB`,

    `CREATE TABLE IF NOT EXISTS picture (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      pathname VARCHAR(255) CHARSET utf8 COLLATE utf8_bin NOT NULL UNIQUE,
      userId INT UNSIGNED NOT NULL,
      title VARCHAR(255) CHARSET utf8 COLLATE utf8_general_ci NULL,
      description VARCHAR(4096) CHARSET utf8 COLLATE utf8_general_ci NULL,
      takenAt TIMESTAMP NULL,
      createdAt TIMESTAMP NOT NULL,
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
      createdAt TIMESTAMP NOT NULL,
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
    'ALTER TABLE user ADD COLUMN admin BOOL',
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
