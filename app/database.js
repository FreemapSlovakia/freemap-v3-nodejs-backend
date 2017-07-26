const config = require('config');
const mysql = require('mysql');
const onFinished = require('on-finished');
const each = require('async/each');

const logger = require('~/logger');

const pool = mysql.createPool(config.get('mysql'));
const VError = require('verror');

function dbMiddleware(req, res, next) {
  pool.getConnection((err, db) => {
    if (err) {
      logger.error({ err }, `Error obtaining DB connection: ${err.message}`);
      res.status(500).end();
    } else {
      onFinished(res, () => {
        db.release();
      });

      req.db = db;
      next();
    }
  });
}

function initDatabase(mainCb) {
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

  pool.getConnection((err, db) => {
    if (err) {
      mainCb(new VError(err, 'Error getting DB connection.'));
      return;
    }

    each(scripts, (script, cb) => {
      db.query(script, cb);
    }, mainCb);
  });
}

function runWithDatabaseConnection(fn, cb) {
  pool.getConnection((err, db) => {
    if (err) {
      cb(err);
    } else {
      fn(db, (...args) => {
        db.release();
        cb(...args);
      });
    }
  });
}

module.exports = { pool, dbMiddleware, initDatabase, runWithDatabaseConnection };
