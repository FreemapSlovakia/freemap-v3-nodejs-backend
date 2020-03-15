const SQL = require('sql-template-strings');
const { pool } = require('~/database');
const { acceptValidator } = require('~/requestValidators');
const authenticator = require('~/authenticator');

module.exports = router => {
  router.get(
    '/',
    acceptValidator('application/json'),
    authenticator(true),
    async ctx => {
      ctx.body = await pool.query(SQL`
        SELECT id, name, public, createdAt, userId
          FROM map
          WHERE userId = ${ctx.state.user.id}
      `);

      for (const item of ctx.body) {
        item.public = !!item.public;
      }
    },
  );
};
