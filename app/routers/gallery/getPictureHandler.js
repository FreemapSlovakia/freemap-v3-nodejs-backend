const { dbMiddleware } = rootRequire('database');
const checkRequestMiddleware = rootRequire('checkRequestMiddleware');
const logger = rootRequire('logger');
const { fromDb, fields } = rootRequire('routers/gallery/galleryCommons');

module.exports = function attachGetPicturesInRadiusHandler(router) {
  router.all(
    '/picture/:id',
    checkRequestMiddleware({ method: 'GET' }),
    dbMiddleware,
    (req, res) => {
      req.db.query(
        `SELECT ${fields}
          FROM fm_Attachment JOIN fm_User ON UserID = user_id
          WHERE RecordID = ?`,
        [req.params.id],
        (err, rows) => {
          if (err) {
            logger.error({ err }, 'Error selecting pictures.');
            res.status(500).end();
          } else if (rows.length) {
            res.json(fromDb(rows[0]));
          } else {
            res.status(404).end();
          }
        },
      );
    },
  );
};
