const SQL = require('sql-template-strings');
const { pool } = require('~/database');
const { acceptValidator } = require('~/requestValidators');
const authenticator = require('~/authenticator');

module.exports = router => {
  router.get(
    '/devices',
    acceptValidator('application/json'),
    authenticator(true),
    async ctx => {
      ctx.body = await pool.query(SQL`
        SELECT id, name, token, createdAt, maxCount, maxAge, userId
          FROM trackingDevice
          WHERE userId = ${ctx.state.user.id}
      `);
    },
  );
};
