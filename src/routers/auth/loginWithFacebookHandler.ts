import Router from '@koa/router';
import { fb } from '../../fb';
import { login } from './loginProcessor';
import { authenticator } from '../../authenticator';

export function attachLoginWithFacebookHandler(router: Router) {
  router.post(
    '/login-fb',
    authenticator(false),
    // TODO validation
    async (ctx) => {
      const { accessToken, language, connect } = ctx.request.body;

      const { id, name, email } = await fb
        .withAccessToken(accessToken)
        .api('/me', { fields: 'id,name,email' });

      await login(
        ctx,
        'facebook',
        id,
        name,
        email ?? null,
        undefined,
        undefined,
        language,
        connect,
      );
    },
  );
}
