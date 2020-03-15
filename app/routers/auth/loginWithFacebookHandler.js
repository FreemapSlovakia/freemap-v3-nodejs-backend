const fb = require('~/fb');

const login = require('./loginProcessor');

module.exports = function attachLoginWithFacebookHandler(router) {
  router.post(
    '/login-fb',
    // TODO validation
    async ctx => {
      const { accessToken } = ctx.request.body;

      const { id, name, email } = await fb
        .withAccessToken(accessToken)
        .api('/me', { fields: 'id,name,email' });

      await login(
        ctx.state.db,
        ctx,
        'facebookUserId',
        id,
        'facebookAccessToken',
        [accessToken],
        name,
        email,
        undefined,
        undefined,
      );
    },
  );
};
