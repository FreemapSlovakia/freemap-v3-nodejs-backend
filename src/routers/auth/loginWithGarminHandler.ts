import Router from '@koa/router';
import rp from 'request-promise-native';
import { tokenSecrets } from './garminTokenSecrets';
import { getEnv } from '../../env';

export function attachLoginWithGarminHandler(router: Router) {
  router.post(
    '/login-garmin',
    // TODO validation
    async (ctx) => {
      const body = await rp.post({
        url: 'https://connectapi.garmin.com/oauth-service/oauth/request_token',
        oauth: {
          consumer_key: getEnv('GARMIN_OAUTH_CONSUMER_KEY'),
          consumer_secret: getEnv('GARMIN_OAUTH_CONSUMER_SECRET'),
        },
      });

      const sp = new URLSearchParams(String(body));

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
