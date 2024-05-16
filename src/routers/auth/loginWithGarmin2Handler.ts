import Router from '@koa/router';
import rp from 'request-promise-native';
import { tokenSecrets } from './garminTokenSecrets';
import { getEnv } from '../../env';
import { login } from './loginProcessor';

export function attachLoginWithGarmin2Handler(router: Router) {
  router.post(
    '/login-garmin-2',
    // TODO validation
    async (ctx) => {
      const { token, verifier, language } = ctx.request.body;

      const consumer_key = getEnv('GARMIN_OAUTH_CONSUMER_KEY');

      const consumer_secret = getEnv('GARMIN_OAUTH_CONSUMER_SECRET');

      const body = await rp.post({
        url: 'https://connectapi.garmin.com/oauth-service/oauth/access_token',
        oauth: {
          consumer_key,
          consumer_secret,
          verifier,
          token,
          token_secret: tokenSecrets.get(ctx.request.body.token),
        },
      });

      const sp = new URLSearchParams(String(body));

      const authToken = sp.get('oauth_token');

      const authTokenSecret = sp.get('oauth_token_secret');

      const body2 = await rp.get({
        url: 'https://apis.garmin.com/wellness-api/rest/user/id',
        oauth: {
          consumer_key,
          consumer_secret,
          token: authToken,
          token_secret: authTokenSecret,
        },
        json: true,
      });

      await login(
        ctx,
        'garminUserId',
        body2.userId,
        'garminAccessToken, garminAccessTokenSecret',
        [sp.get('oauth_token'), sp.get('oauth_token_secret')],
        body2.userId,
        null,
        undefined,
        undefined,
        language,
      );
    },
  );
}
