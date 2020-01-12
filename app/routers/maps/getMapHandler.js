const { dbMiddleware } = require('~/database');
const { acceptValidator } = require('~/requestValidators');
const authenticator = require('~/authenticator');

module.exports = router => {
  router.get(
    '/:id',
    acceptValidator('application/json'),
    dbMiddleware(),
    authenticator(true),
    async ctx => {
      const [item] = await ctx.state.db.query(
        `SELECT id, name, public, data, createdAt, userId
          FROM map
          WHERE id = ?`,
        [ctx.params.id],
      );

      if (!item) {
        ctx.status = 404;
      } else if (
        !item.public &&
        !ctx.state.user.isAdmin &&
        ctx.state.user.id !== item.userId
      ) {
        ctx.status = 403;
      } else {
        item.data = JSON.parse(item.data);
        item.public = !!item.public;
        ctx.body = item;
      }
    },
  );
};
