const { dbMiddleware } = require('~/database');
const { acceptValidator } = require('~/requestValidators');
const authenticator = require('~/authenticator');

module.exports = router => {
  router.get(
    '/',
    acceptValidator('application/json'),
    dbMiddleware(),
    authenticator(true),
    async ctx => {
      ctx.body = await ctx.state.db.query(
        `SELECT id, name, public, createdAt, userId
          FROM map
          WHERE userId = ?`,
        [ctx.state.user.id],
      );

      for (const item of ctx.body) {
        item.public = !!item.public;
      }
    },
  );
};
