const config = require('config');
const mysql = require('mysql');
const onFinished = require('on-finished');

const logger = rootRequire('logger');

const pool = mysql.createPool(config.get('mysql'));

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

module.exports = { pool, dbMiddleware };
