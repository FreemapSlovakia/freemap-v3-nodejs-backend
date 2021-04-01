import Router from '@koa/router';
import { googleClient } from '../../google';
import { login } from './loginProcessor';

export function attachLoginWithGoogleHandler(router: Router) {
  router.post(
    '/login-google',
    // TODO validation
    async (ctx) => {
      const { idToken, language, preventTips } = ctx.request.body;

      const { sub, name, email } = (
        await googleClient.verifyIdToken({
          idToken,
        } as any)
      ).getPayload(); // TODO catch error

      await login(
        ctx,
        'googleUserId',
        sub,
        'googleIdToken',
        [idToken],
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
