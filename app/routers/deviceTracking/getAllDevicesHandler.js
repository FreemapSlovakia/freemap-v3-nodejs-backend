const { dbMiddleware } = require('~/database');
const { acceptValidator } = require('~/requestValidators');


module.exports = (router) => {
  router.get(
    '/devices',
    acceptValidator('application/json'),
    dbMiddleware,
    async (ctx) => {
      ctx.body = await ctx.state.db.query(
        'SELECT id, name, token, createdAt FROM trackingDevice WHERE userId = ?',
        [ctx.state.user.id],
      );
    },
  );
};
