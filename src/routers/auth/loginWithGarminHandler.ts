import { RouterInstance } from '@koa/router';
import { getEnv } from '../../env.js';
import { garminOauth } from '../../garminOauth.js';
import { acceptValidator } from '../../requestValidators.js';
import { tokenSecrets } from './garminTokenSecrets.js';

export function attachLoginWithGarminHandler(router: RouterInstance) {
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
        throw new Error('Authorization error: ' + (await response.text()));
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

      const body = ctx.request.body as any;

      tokenSecrets.set(token, {
        tokenSecret,
        connect: Boolean(body.connect),
        clientData: body.clientData,
      });

      setTimeout(() => tokenSecrets.delete(token), 30 * 60_000); // max 30 minutes

      const callback = new URL(getEnv('GARMIN_OAUTH_CALLBACK'));

      // extraQuery is unused now
      for (const [key, value] of Object.entries(body.extraQuery ?? {})) {
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
