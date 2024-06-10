import Router from '@koa/router';
import { authenticator } from '../../authenticator.js';
import { googleClient } from '../../google.js';
import { acceptValidator } from '../../requestValidators.js';
import { login } from './loginProcessor.js';

export function attachLoginWithGoogleHandler(router: Router) {
  router.post(
    '/login-google',
    authenticator(false),
    acceptValidator('application/json'),
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
