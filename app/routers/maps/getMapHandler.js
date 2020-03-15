const SQL = require('sql-template-strings');
const { pool } = require('~/database');
const { acceptValidator } = require('~/requestValidators');
const authenticator = require('~/authenticator');

module.exports = router => {
  router.get(
    '/:id',
    acceptValidator('application/json'),
    authenticator(false),
    async ctx => {
      const [item] = await pool.query(SQL`
        SELECT id, name, public, data, createdAt, userId
          FROM map
          WHERE id = ${Number(ctx.params.id)}
      `);

      if (!item) {
        ctx.throw(404);
      }

      if (
        !item.public &&
        (!ctx.state.user ||
          (!ctx.state.user.isAdmin && ctx.state.user.id !== item.userId))
      ) {
        ctx.throw(403);
      }

      item.data = JSON.parse(item.data);

      item.public = !!item.public;

      ctx.body = item;
    },
  );
};
