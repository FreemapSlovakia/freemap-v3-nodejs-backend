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

type Body = {
  accessToken: string;
  language: string | null;
  connect?: boolean;
};

export function attachLoginWithFacebookHandler(router: RouterInstance) {
  router.post(
    '/login-fb',
    authenticator(false),
    // TODO validation
    async (ctx) => {
      let body;

      try {
        body = assert<Body>(ctx.request.body);
      } catch (err) {
        return ctx.throw(400, err as Error);
      }

      const { accessToken, language, connect } = body;

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
