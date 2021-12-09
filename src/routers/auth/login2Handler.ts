import Router from '@koa/router';
import rp from 'request-promise-native';
import qs from 'querystring';
import { parseString } from 'xml2js';
import { promisify } from 'util';
import { requestTokenRegistry } from './requestTokenRegistry';
import { login } from './loginProcessor';
import { getEnv } from '../../env';

const parseStringAsync = promisify(parseString);

const consumerKey = getEnv('OAUTH_CONSUMER_KEY');

const consumerSecret = getEnv('OAUTH_CONSUMER_SECRET');

export function attachLogin2Handler(router: Router) {
  router.post(
    '/login2',
    // TODO validation
    async (ctx) => {
      const { token, verifier, language, preventTips } = ctx.request.body;

      const body = await rp.post({
        url: 'https://www.openstreetmap.org/oauth/access_token',
        oauth: {
          consumer_key: consumerKey,
          consumer_secret: consumerSecret,
          token,
          token_secret: requestTokenRegistry.get(token),
          verifier,
        },
      });

      const permData = qs.parse(body) as {
        oauth_token: string;
        oauth_token_secret: string;
      };

      const userDetails = await rp.get({
        url: 'https://api.openstreetmap.org/api/0.6/user/details',
        oauth: {
          consumer_key: consumerKey,
          consumer_secret: consumerSecret,
          token: permData.oauth_token as string,
          token_secret: permData.oauth_token_secret as string,
        },
      });

      const result = await parseStringAsync(userDetails);

      const {
        $: { display_name: osmName, id: osmId },
        home,
      } = (result as any).osm.user[0];

      const { lat, lon } = (home && home.length && home[0].$) || {};

      await login(
        ctx,
        'osmId',
        osmId,
        'osmAuthToken, osmAuthTokenSecret',
        [permData.oauth_token, permData.oauth_token_secret],
        osmName,
        null,
        lat ? Number(lat) : undefined,
        lon ? Number(lon) : undefined,
        language,
        preventTips,
      );
    },
  );
}
