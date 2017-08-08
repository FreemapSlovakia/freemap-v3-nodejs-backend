const { dbMiddleware } = require('~/database');
const { fromDb, fields } = require('~/routers/gallery/galleryCommons');
const { acceptValidator } = require('~/requestValidators');

module.exports = function attachGetPicturesInRadiusHandler(router) {
  router.get(
    '/picture/:id',
    acceptValidator('application/json'),
    dbMiddleware,
    async (ctx) => {
      const rows = await ctx.state.db.query(
        `SELECT ${fields} FROM picture LEFT JOIN user ON userId = user.id WHERE picture.id = ?`,
        [ctx.params.id],
      );

      if (rows.length) {
        ctx.body = fromDb(rows[0]);
      } else {
        ctx.status = 404;
      }
    },
  );
};
