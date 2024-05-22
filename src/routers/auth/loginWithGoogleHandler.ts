import Router from '@koa/router';
import { googleClient } from '../../google';
import { login } from './loginProcessor';
import { authenticator } from '../../authenticator';

export function attachLoginWithGoogleHandler(router: Router) {
  router.post(
    '/login-google',
    authenticator(false),
    // TODO validation
    async (ctx) => {
      const { idToken, language, connect } = ctx.request.body;

      const { sub, name, email } = (
        await googleClient.verifyIdToken({
          idToken,
        } as any)
      ).getPayload(); // TODO catch error

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
