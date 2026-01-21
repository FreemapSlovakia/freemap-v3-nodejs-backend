import { RouterInstance } from '@koa/router';
import got from 'got';
import { assert, assertGuard } from 'typia';
import { authenticator } from '../../authenticator.js';
import { getEnv } from '../../env.js';
import { acceptValidator } from '../../requestValidators.js';
import { login } from './loginProcessor.js';

const clientId = getEnv('OSM_OAUTH2_CLIENT_ID');

const clientSecret = getEnv('OSM_OAUTH2_CLIENT_SECRET');

export function attachLoginWithOsmHandler(router: RouterInstance) {
  router.get('/login-osm', (ctx) => {
    ctx.body = { clientId };
  });

  router.post(
    '/login-osm',
    authenticator(false),
    acceptValidator('application/json'),
    // TODO validation
    async (ctx) => {
      let bdy;

      type Body = {
        code: string;
        language: string | null;
        connect?: boolean;
        redirectUri: string;
      };

      try {
        bdy = assert<Body>(ctx.request.body);
      } catch (err) {
        return ctx.throw(400, err as Error);
      }

      const { code, language, connect, redirectUri } = bdy;

      const sp = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'authorization_code',
        code,
        redirect_uri:
          redirectUri + (connect === undefined ? '' : '?connect=' + connect),
      });

      const body = await got
        .post('https://www.openstreetmap.org/oauth2/token?' + sp.toString(), {
          headers: {
            'content-type': 'application/x-www-form-urlencoded', // otherwise server returns 415
          },
        })
        .json();

      assertGuard<{ access_token: string }>(body);

      const userDetails = await got
        .get('https://api.openstreetmap.org/api/0.6/user/details', {
          headers: {
            authorization: 'Bearer ' + body.access_token,
          },
        })
        .json();

      assertGuard<{
        user: {
          id: number;
          display_name: string;
          home?: { lat: number; lon: number };
        };
      }>(userDetails);

      const {
        user: { display_name: osmName, id: osmId, home },
      } = userDetails;

      const { lat, lon } = home ?? {};

      await login(
        ctx,
        'osm',
        Number(osmId),
        osmName,
        null,
        lat === undefined ? undefined : Number(lat),
        lon === undefined ? undefined : Number(lon),
        language,
        connect,
      );
    },
  );
}
