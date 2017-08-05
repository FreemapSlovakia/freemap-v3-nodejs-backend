const config = require('config');
const mysql = require('promise-mysql');

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
  ];

  const db = await pool.getConnection();
  try {
    for (const stript of scripts) {
      await db.query(stript);
    }
  } finally {
    pool.releaseConnection(db);
  }
}

module.exports = { pool, dbMiddleware, initDatabase };
