const { dbMiddleware } = require('~/database');
const authenticator = require('~/authenticator');

module.exports = function attachLogoutHandler(router) {
  router.post(
    '/validate',
    dbMiddleware(),
    authenticator(true, true),
    async ctx => {
      ctx.body = ctx.state.user;
    }
  );
};
