const { dbMiddleware } = require('~/database');
const { fromDb, fields } = require('~/routers/gallery/galleryCommons');

module.exports = function attachGetPicturesInRadiusHandler(router) {
  router.get(
    '/picture/:id',
    dbMiddleware,
    async (ctx) => {
      const rows = await ctx.state.db.query(
        `SELECT ${fields} FROM fm_Attachment JOIN fm_User ON UserID = user_id WHERE RecordID = ?`,
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
