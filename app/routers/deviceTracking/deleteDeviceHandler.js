const { dbMiddleware } = require('~/database');
const { acceptValidator } = require('~/requestValidators');
const authenticator = require('~/authenticator');


module.exports = (router) => {
  router.delete(
    '/devices/:id',
    acceptValidator('application/json'),
    dbMiddleware(),
    authenticator(true),
    async (ctx) => {
      const [item] = await ctx.state.db.query('SELECT userId FROM trackingDevice WHERE id = ? FOR UPDATE', [ctx.params.id]);
      if (!item) {
        ctx.status = 404;
      } else if (!ctx.state.user.isAdmin && item.userId !== ctx.state.user.id) {
        ctx.status = 403;
      } else {
        await ctx.state.db.query('DELETE FROM trackingDevice WHERE id = ?', [ctx.params.id]);
        ctx.status = 204;
      }
    },
  );
};
