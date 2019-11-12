const { dbMiddleware } = require('~/database');
const { acceptValidator } = require('~/requestValidators');
const authenticator = require('~/authenticator');

module.exports = router => {
  router.delete(
    '/access-tokens/:id',
    acceptValidator('application/json'),
    dbMiddleware(),
    authenticator(true),
    async ctx => {
      const [item] = await ctx.state.db.query(
        `SELECT userId FROM trackingAccessToken
          JOIN trackingDevice ON (deviceId = trackingDevice.id)
          WHERE trackingAccessToken.id = ? FOR UPDATE`,
        [ctx.params.id],
      );

      if (!item) {
        ctx.status = 404;
      } else if (!ctx.state.user.isAdmin && item.userId !== ctx.state.user.id) {
        ctx.status = 403;
      } else {
        await ctx.state.db.query(
          'DELETE FROM trackingAccessToken WHERE id = ?',
          [ctx.params.id],
        );
        ctx.status = 204;
      }
    },
  );
};
