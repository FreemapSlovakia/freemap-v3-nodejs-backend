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
      userId INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(255) CHARSET utf8 COLLATE utf8_general_ci NOT NULL,
      createdAt TIMESTAMP NOT NULL,
      lastLoginAt TIMESTAMP NULL,
      authToken VARCHAR(255) CHARSET utf8 COLLATE utf8_bin NULL UNIQUE,
      osmId INT UNSIGNED NULL UNIQUE,
      osmAuthToken VARCHAR(255) CHARSET utf8 COLLATE utf8_bin NULL UNIQUE
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
