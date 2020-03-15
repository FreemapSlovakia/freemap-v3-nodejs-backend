const { pool } = require('~/database');
const { acceptValidator } = require('~/requestValidators');

module.exports = function attachGetAllUsersHandler(router) {
  router.get(
    '/picture-users',
    acceptValidator('application/json'),
    async ctx => {
      ctx.body = await pool.query(
        `SELECT userId AS id, user.name AS name, COUNT(*) AS count
          FROM picture
          JOIN user ON userId = user.id
          GROUP BY userId
          ORDER BY user.name`,
      );
    },
  );
};
