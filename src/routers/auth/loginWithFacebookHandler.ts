import { RouterInstance } from '@koa/router';
import got from 'got';
import { authenticator } from '../../authenticator.js';
import { login } from './loginProcessor.js';
import { assert } from 'typia';

async function getUserData(accessToken: string) {
  return assert<{ id: string; name: string; email?: string | null }>(
    await got(
      'https://graph.facebook.com/v20.0/me?fields=id,name,email&access_token=' +
        encodeURIComponent(accessToken),
    ).json(),
  );
}

export function attachLoginWithFacebookHandler(router: RouterInstance) {
  router.post(
    '/login-fb',
    authenticator(false),
    // TODO validation
    async (ctx) => {
      const { accessToken, language, connect } = ctx.request.body as any;

      const { id, name, email } = await getUserData(accessToken);

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
