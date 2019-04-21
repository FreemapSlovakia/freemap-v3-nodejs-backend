const { dbMiddleware } = require('~/database');
const { acceptValidator } = require('~/requestValidators');
const authenticator = require('~/authenticator');

module.exports = (router) => {
  router.get(
    '/devices/:id/access-token',
    acceptValidator('application/json'),
    dbMiddleware,
    authenticator(true),
    async (ctx) => {
      const [device] = await ctx.state.db.query(
        'SELECT userId FROM trackingDevice WHERE id = ?',
        [ctx.params.id],
      );

      if (!device) {
        ctx.state = 404;
      } else if (!ctx.state.user.isAdmin && ctx.state.user.id !== device.userId) {
        ctx.status = 403;
      } else {
        ctx.body = (await ctx.state.db.query(
          'SELECT id, token, createdAt, validTo, note, listed FROM trackingAccessTokens WHERE deviceId = ?',
          [ctx.params.id],
        )).map(item => ({ ...item, listed: !!item.listed }));
      }
    },
  );
};
