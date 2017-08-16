const fs = require('fs');
const { dbMiddleware } = require('~/database');
const { acceptValidator } = require('~/requestValidators');

module.exports = function attachGetPictureHandler(router) {
  router.get(
    '/pictures/:id/image',
    acceptValidator('image/jpeg'),
    dbMiddleware,
    async (ctx) => {
      const rows = await ctx.state.db.query(
        'SELECT pathname FROM picture WHERE picture.id = ?',
        [ctx.params.id],
      );

      // TODO caching

      if (rows.length) {
        ctx.type = 'image/jpeg';
        ctx.body = fs.createReadStream(`${global.rootDir}/user_data/pictures/${rows[0].pathname}`);
      } else {
        ctx.status = 404;
      }
    },
  );
};
