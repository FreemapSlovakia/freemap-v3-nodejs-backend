const { dbMiddleware } = require('~/database');
const { acceptValidator } = require('~/requestValidators');

module.exports = function attachGetAllUsersHandler(router) {
  router.get(
    '/picture-users',
    acceptValidator('application/json'),
    dbMiddleware(),
    async ctx => {
      ctx.body = await ctx.state.db.query(
        `SELECT userId AS id, user.name AS name, COUNT(*) AS count
          FROM picture
          JOIN user ON userId = user.id
          GROUP BY userId
          ORDER BY user.name`
      );
    }
  );
};
