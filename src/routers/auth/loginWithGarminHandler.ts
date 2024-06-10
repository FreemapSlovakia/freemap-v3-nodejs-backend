import Router from '@koa/router';
import { getEnv } from '../../env.js';
import { garminOauth } from '../../garminOauth.js';
import { tokenSecrets } from './garminTokenSecrets.js';

export function attachLoginWithGarminHandler(router: Router) {
  router.post(
    '/login-garmin',
    // TODO validation
    async (ctx) => {
      const url =
        'https://connectapi.garmin.com/oauth-service/oauth/request_token';

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          ...garminOauth.toHeader(
            garminOauth.authorize({
              url,
              method: 'POST',
            }),
          ),
        },
      });

      if (!response.ok) {
        ctx.log.error(await response.text());
        ctx.throw(500);
      }

      const sp = new URLSearchParams(await response.text());

      const token = sp.get('oauth_token');

      tokenSecrets.set(token, sp.get('oauth_token_secret'));

      setTimeout(() => tokenSecrets.delete(token), 30 * 60_000); // max 30 minutes

      const callback = getEnv('GARMIN_OAUTH_CALLBACK');

      ctx.body = {
        redirectUrl:
          'https://connect.garmin.com/oauthConfirm?oauth_callback=' +
          encodeURIComponent(callback) +
          '&oauth_token=' +
          encodeURIComponent(token),
      };
    },
  );
}
