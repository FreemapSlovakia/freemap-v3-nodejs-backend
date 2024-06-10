import Router from '@koa/router';
import got from 'got';
import { authenticator } from '../../authenticator.js';
import { garminOauth } from '../../garminOauth.js';
import { tokenSecrets } from './garminTokenSecrets.js';
import { login } from './loginProcessor.js';

export function attachLoginWithGarmin2Handler(router: Router) {
  router.post(
    '/login-garmin-2',
    authenticator(false),
    // TODO validation
    async (ctx) => {
      const { token, verifier, language, connect } = ctx.request.body;

      const url =
        'https://connectapi.garmin.com/oauth-service/oauth/access_token';

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          ...garminOauth.toHeader(
            garminOauth.authorize(
              {
                url,
                method: 'POST',
                data: { oauth_verifier: verifier },
              },
              {
                key: token,
                secret: tokenSecrets.get(ctx.request.body.token),
              },
            ),
          ),
        },
      });

      if (!response.ok) {
        ctx.log.error(await response.text());
        ctx.throw(500);
      }

      const sp = new URLSearchParams(await response.text());

      const authToken = sp.get('oauth_token');

      const authTokenSecret = sp.get('oauth_token_secret');

      const url2 = 'https://apis.garmin.com/wellness-api/rest/user/id';

      const body2 = (await got
        .get(url2, {
          headers: {
            ...garminOauth.toHeader(
              garminOauth.authorize(
                {
                  url: url2,
                  method: 'GET',
                },
                {
                  key: authToken,
                  secret: authTokenSecret,
                },
              ),
            ),
          },
        })
        .json()) as any;

      await login(
        ctx,
        'garmin',
        body2.userId,
        body2.userId,
        null,
        undefined,
        undefined,
        language,
        connect,
        {
          garminAccessToken: authToken,
          garminAccessTokenSecret: authTokenSecret,
        },
      );
    },
  );
}
