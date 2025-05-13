import Router from '@koa/router';
import got from 'got';
import { authenticator } from '../../authenticator.js';
import { getEnv } from '../../env.js';
import { acceptValidator } from '../../requestValidators.js';
import { login } from './loginProcessor.js';

const clientId = getEnv('OSM_OAUTH2_CLIENT_ID')!;

const clientSecret = getEnv('OSM_OAUTH2_CLIENT_SECRET')!;

const redirectUri = getEnv('OSM_OAUTH2_REDIRECT_URI');

export function attachLoginWithOsmHandler(router: Router) {
  router.get('/login-osm', (ctx) => {
    ctx.body = { clientId };
  });

  router.post(
    '/login-osm',
    authenticator(false),
    acceptValidator('application/json'),
    // TODO validation
    async (ctx) => {
      const { code, language, connect } = ctx.request.body;

      const sp = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'authorization_code',
        code,
        redirect_uri:
          redirectUri + (connect === undefined ? '' : '?connect=' + connect),
      });

      const body = (await got
        .post('https://www.openstreetmap.org/oauth2/token?' + sp.toString(), {
          headers: {
            'content-type': 'application/x-www-form-urlencoded', // otherwise server returns 415
          },
        })
        .json()) as any;

      const userDetails = await got
        .get('https://api.openstreetmap.org/api/0.6/user/details', {
          headers: {
            authorization: 'Bearer ' + body.access_token,
          },
        })
        .json();

      const {
        user: { display_name: osmName, id: osmId, home },
      } = userDetails as any;

      const { lat, lon } = (home && home.length && home[0].$) || {};

      await login(
        ctx,
        'osm',
        osmId,
        osmName,
        null,
        lat ? Number(lat) : undefined,
        lon ? Number(lon) : undefined,
        language,
        connect,
      );
    },
  );
}
