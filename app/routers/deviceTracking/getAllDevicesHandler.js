const { dbMiddleware } = require('~/database');
const { acceptValidator } = require('~/requestValidators');
const authenticator = require('~/authenticator');

module.exports = (router) => {
  router.get(
    '/devices',
    acceptValidator('application/json'),
    dbMiddleware(),
    authenticator(true),
    async (ctx) => {
      ctx.body = await ctx.state.db.query(
        'SELECT id, name, token, createdAt, userId FROM trackingDevice WHERE userId = ?',
        [ctx.state.user.id],
      );
    },
  );
};
