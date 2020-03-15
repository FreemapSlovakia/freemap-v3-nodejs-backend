const SQL = require('sql-template-strings');
const { pool } = require('~/database');
const { acceptValidator } = require('~/requestValidators');
const authenticator = require('~/authenticator');

module.exports = router => {
  router.get(
    '/devices/:id',
    acceptValidator('application/json'),
    authenticator(true),
    async ctx => {
      const [item] = await pool.query(SQL`
        SELECT id, name, token, createdAt, maxCount, maxAge, userId
          FROM trackingDevice
          WHERE id = ${ctx.params.id}
      `);

      if (!item) {
        ctx.throw(404);
      }

      if (!ctx.state.user.isAdmin && ctx.state.user.id !== item.userId) {
        ctx.throw(403);
      }

      ctx.body = item;
    },
  );
};
