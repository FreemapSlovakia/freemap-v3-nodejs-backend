const { dbMiddleware } = require('~/database');

module.exports = function attachLogoutHandler(router) {
  router.post(
    '/logout',
    dbMiddleware,
    async (ctx) => {
      const ah = ctx.get('Authorization');

      const m = /^bearer (.+)$/i.exec(ah || '');
      if (!m) {
        ctx.status = 401;
        ctx.set('WWW-Authenticate', 'Bearer realm="freemap"; error="missing token"');
        return;
      }

      const { affectedRows } = await ctx.state.db.query('DELETE FROM auth WHERE authToken = ?', [m[1]]);

      if (affectedRows) {
        ctx.status = 204;
      } else {
        ctx.status = 401;
        ctx.set('WWW-Authenticate', 'Bearer realm="freemap"; error="invalid token"');
      }
    },
  );
};
