import Router from '@koa/router';
import { login } from './loginProcessor.js';
import { authenticator } from '../../authenticator.js';
import got from 'got';

async function getUserData(accessToken: string) {
  return await got(
    'https://graph.facebook.com/v20.0/me?fields=id,name,email&access_token=' +
      encodeURIComponent(accessToken),
  ).json();
}

export function attachLoginWithFacebookHandler(router: Router) {
  router.post(
    '/login-fb',
    authenticator(false),
    // TODO validation
    async (ctx) => {
      const { accessToken, language, connect } = ctx.request.body;

      const { id, name, email } = (await getUserData(accessToken)) as any;

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
