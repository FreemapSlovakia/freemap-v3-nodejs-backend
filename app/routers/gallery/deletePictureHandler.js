const { dbMiddleware } = require('~/database');
const authenticator = require('~/authenticator');
const { promisify } = require('util');
const { unlink } = require('fs');

const unlinkAsync = promisify(unlink);
const { PICTURES_DIR } = require('~/routers/gallery/constants');

module.exports = function attachDeletePictureHandler(router) {
  router.delete(
    '/pictures/:id',
    dbMiddleware(),
    authenticator(true),
    async (ctx) => {
      // TODO transaction

      const rows = await ctx.state.db.query('SELECT pathname, userId FROM picture WHERE id = ? FOR UPDATE', [ctx.params.id]);
      if (rows.length === 0) {
        ctx.status = 404;
        return;
      }

      if (!ctx.state.user.isAdmin && rows[0].userId !== ctx.state.user.id) {
        ctx.status = 403;
        return;
      }

      await ctx.state.db.query('DELETE FROM picture WHERE id = ?', [ctx.params.id]);

      await unlinkAsync(`${PICTURES_DIR}/${rows[0].pathname}`);

      ctx.status = 204;
    },
  );
};
