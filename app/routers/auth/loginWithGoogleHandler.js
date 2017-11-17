const { dbMiddleware } = require('~/database');
const { verifyIdToken, clientId } = require('~/google');

const login = require('./loginProcessor');

module.exports = function attachLoginWithFacebookHandler(router) {
  router.post(
    '/login-google',
    // TODO validation
    dbMiddleware,
    async (ctx) => {
      const { idToken } = ctx.request.body;

      const { sub, name, email } = (await verifyIdToken(idToken, clientId)).getPayload(); // TODO catch error

      await login(ctx.state.db, ctx, 'googleUserId', sub, 'googleIdToken', [idToken], name, email, undefined, undefined);
    },
  );
};
