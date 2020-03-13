const SQL = require('sql-template-strings');
const { dbMiddleware } = require('~/database');
const authenticator = require('~/authenticator');

module.exports = function attachLogoutHandler(router) {
  router.post('/logout', dbMiddleware(), authenticator(true), async ctx => {
    const { affectedRows } = await ctx.state.db.query(
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
