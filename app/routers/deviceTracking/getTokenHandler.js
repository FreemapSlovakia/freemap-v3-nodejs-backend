const { dbMiddleware } = require('~/database');
const { acceptValidator } = require('~/requestValidators');
const authenticator = require('~/authenticator');

module.exports = (router) => {
  router.get(
    '/access-tokens/:id',
    acceptValidator('application/json'),
    dbMiddleware(),
    authenticator(true),
    async (ctx) => {
      const [item] = await ctx.state.db.query(
        `SELECT id, token, createdAt, timeFrom, timeTo, note, listed
          FROM trackingAccessTokens JOIN trackingDevice ON (trackingAccessTokens.deviceId = trackingDevice.id)
          WHERE id = ? ORDER BY id`,
        [ctx.params.id],
      );

      if (!item) {
        ctx.status = 404;
      } else if (!ctx.state.user.isAdmin && ctx.state.user.id !== item.userId) {
        ctx.status = 403;
      } else {
        item.listed = !!item.listed;
        ctx.body = item;
      }
    },
  );
};
