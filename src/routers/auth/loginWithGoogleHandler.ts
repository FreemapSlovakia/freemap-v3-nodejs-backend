import { RouterInstance } from '@koa/router';
import { authenticator } from '../../authenticator.js';
import { acceptValidator } from '../../requestValidators.js';
import { login } from './loginProcessor.js';
import { assert } from 'typia';

type Body = {
  accessToken: string;
  language: string | null;
  connect?: boolean;
};

export function attachLoginWithGoogleHandler(router: RouterInstance) {
  router.post(
    '/login-google',
    authenticator(false),
    acceptValidator('application/json'),
    // TODO validation
    async (ctx) => {
      let body;

      try {
        body = assert<Body>(ctx.request.body);
      } catch (err) {
        ctx.log.warn({ body }, 'Invalid body.');

        return ctx.throw(400, err as Error);
      }

      const { accessToken, language, connect } = body;

      const userinfoRes = await fetch(
        'https://openidconnect.googleapis.com/v1/userinfo',
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        },
      );

      if (!userinfoRes.ok) {
        throw new Error('Failed to fetch user info from Google');
      }

      const { sub, name, email } = assert<{
        sub: string;
        name?: string;
        email?: string;
      }>(await userinfoRes.json());

      await login(
        ctx,
        'google',
        sub,
        name,
        email,
        undefined,
        undefined,
        language,
        connect,
      );
    },
  );
}
