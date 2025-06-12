import Router from '@koa/router';
import { getEnv } from '../../env.js';
import { garminOauth } from '../../garminOauth.js';
import { acceptValidator } from '../../requestValidators.js';
import { tokenSecrets } from './garminTokenSecrets.js';

export function attachLoginWithGarminHandler(router: Router) {
  router.post(
    '/login-garmin',
    acceptValidator('application/json'),
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

      if (!token) {
        return ctx.throw(400, 'missing oauth_token');
      }

      const tokenSecret = sp.get('oauth_token_secret');

      if (!tokenSecret) {
        return ctx.throw(400, 'missing oauth_token_secret');
      }

      tokenSecrets.set(token, {
        tokenSecret,
        connect: Boolean(ctx.request.body.connect),
        clientData: ctx.request.body.clientData,
      });

      setTimeout(() => tokenSecrets.delete(token), 30 * 60_000); // max 30 minutes

      const callback = new URL(getEnv('GARMIN_OAUTH_CALLBACK'));

      // extraQuery is unused now
      for (const [key, value] of Object.entries(
        ctx.request.body.extraQuery ?? {},
      )) {
        callback.searchParams.set(key, String(value));
      }

      ctx.body = {
        redirectUrl:
          'https://connect.garmin.com/oauthConfirm?oauth_callback=' +
          encodeURIComponent(callback.toString()) +
          '&oauth_token=' +
          encodeURIComponent(token),
      };
    },
  );
}
