const { dbMiddleware } = require('~/database');
const authenticator = require('~/authenticator');

module.exports = function attachLogoutHandler(router) {
  router.post(
    '/logout',
    dbMiddleware(),
    authenticator(true),
    async (ctx) => {
      const { affectedRows } = await ctx.state.db.query('DELETE FROM auth WHERE authToken = ?', ctx.state.user.authToken);

      if (affectedRows) {
        ctx.status = 204;
      } else {
        ctx.status = 401;
        ctx.set('WWW-Authenticate', 'Bearer realm="freemap"; error="invalid token"');
      }
    },
  );
};
