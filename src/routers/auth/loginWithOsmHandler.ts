import Router from '@koa/router';
import rp from 'request-promise-native';
import { parseString } from 'xml2js';
import { promisify } from 'util';
import { login } from './loginProcessor';
import { getEnv } from '../../env';

const parseStringAsync = promisify(parseString);

const clientId = getEnv('OSM_OAUTH2_CLIENT_ID');

const clientSecret = getEnv('OSM_OAUTH2_CLIENT_SECRET');

const redirectUri = getEnv('OSM_OAUTH2_REDIRECT_URI');

export function attachLoginWithOsmHandler(router: Router) {
  router.get('/login-osm', (ctx) => {
    ctx.body = { clientId };
  });

  router.post(
    '/login-osm',
    // TODO validation
    async (ctx) => {
      const { code, language } = ctx.request.body;

      const body = await rp.post({
        url:
          'https://www.openstreetmap.org/oauth2/token?' +
          new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            grant_type: 'authorization_code',
            code,
            redirect_uri: redirectUri,
          }).toString(),
        headers: {
          'content-type': 'application/x-www-form-urlencoded', // otherwise server returns 415
        },
        json: true,
      });

      const userDetails = await rp.get({
        url: 'https://api.openstreetmap.org/api/0.6/user/details',
        auth: {
          bearer: body.access_token,
        },
      });

      const result: any = await parseStringAsync(userDetails);

      const {
        $: { display_name: osmName, id: osmId },
        home,
      } = result.osm.user[0];

      const { lat, lon } = (home && home.length && home[0].$) || {};

      await login(
        ctx,
        'osmId',
        osmId,
        'osmAccessToken',
        [body.access_token],
        osmName,
        null,
        lat ? Number(lat) : undefined,
        lon ? Number(lon) : undefined,
        language,
      );
    },
  );
}
