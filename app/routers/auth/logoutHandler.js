const SQL = require('sql-template-strings');
const { pool } = require('~/database');
const authenticator = require('~/authenticator');

module.exports = function attachLogoutHandler(router) {
  router.post('/logout', authenticator(true), async ctx => {
    const { affectedRows } = await pool.query(
      SQL`DELETE FROM auth WHERE authToken = ${ctx.state.user.authToken}`,
    );

    if (!affectedRows) {
      ctx.set(
        'WWW-Authenticate',
        'Bearer realm="freemap"; error="invalid token"',
      );

      ctx.throw(401);
    }

    ctx.status = 204;
  });
};
