const { dbMiddleware } = require('~/database');
const { acceptValidator } = require('~/requestValidators');


module.exports = function attachGetAllUsersHandler(router) {
  router.get(
    '/picture-users',
    acceptValidator('application/json'),
    dbMiddleware,
    async (ctx) => {
      const rows = await ctx.state.db.query('SELECT DISTINCT userId AS id, user.name AS name FROM picture JOIN user ON (userId = user.id) ORDER BY user.name');
      ctx.body = rows;
    },
  );
};
