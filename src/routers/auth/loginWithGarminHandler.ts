import Router from '@koa/router';
import { tokenSecrets } from './garminTokenSecrets.js';
import { getEnv } from '../../env.js';
import OAuth from 'oauth-1.0a';
import got from 'got';

export const garminOauth = new OAuth({
  consumer: {
    key: getEnv('GARMIN_OAUTH_CONSUMER_KEY'),
    secret: getEnv('GARMIN_OAUTH_CONSUMER_SECRET'),
  },
  signature_method: 'HMAC-SHA1',
});

export function attachLoginWithGarminHandler(router: Router) {
  router.post(
    '/login-garmin',
    // TODO validation
    async (ctx) => {
      const url =
        'https://connectapi.garmin.com/oauth-service/oauth/request_token';

      const response = await got.post(url, {
        headers: {
          ...garminOauth.toHeader(
            garminOauth.authorize({
              url,
              method: 'POST',
            }),
          ),
        },
      });

      const sp = new URLSearchParams(String(response.body));

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
