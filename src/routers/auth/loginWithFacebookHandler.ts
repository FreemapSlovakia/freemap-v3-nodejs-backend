import Router from '@koa/router';
import { fb } from '../../fb';
import { login } from './loginProcessor';

export function attachLoginWithFacebookHandler(router: Router) {
  router.post(
    '/login-fb',
    // TODO validation
    async (ctx) => {
      const { accessToken, language, preventTips } = ctx.request.body;

      const { id, name, email } = await fb
        .withAccessToken(accessToken)
        .api('/me', { fields: 'id,name,email' });

      await login(
        ctx,
        'facebookUserId',
        id,
        'facebookAccessToken',
        [accessToken],
        name,
        email,
        undefined,
        undefined,
        language,
        preventTips,
      );
    },
  );
}
