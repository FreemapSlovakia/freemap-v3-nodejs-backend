const { dbMiddleware } = require('~/database');
const authenticator = require('~/authenticator');

module.exports = function attachGetPicturesInRadiusHandler(router) {
  router.delete(
    '/picture/:id',
    dbMiddleware,
    authenticator(true),
    async (ctx) => {
      const { affectedRows } = await ctx.state.db.query(
        `DELETE FROM picture WHERE id = ?${ctx.state.user.admin ? '' : ` AND userId = ${ctx.state.user.id}`}`,
        [ctx.params.id],
      );

      // TODO return 403 instead of 404 in case of use mismatch
      ctx.status = affectedRows ? 204 : 404;
    },
  );
};
