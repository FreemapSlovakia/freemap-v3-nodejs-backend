import Router from '@koa/router';
import { googleClient } from '../../google.js';
import { login } from './loginProcessor.js';
import { authenticator } from '../../authenticator.js';

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
