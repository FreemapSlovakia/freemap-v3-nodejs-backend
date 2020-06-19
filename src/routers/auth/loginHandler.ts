import Router from '@koa/router';
import rp from 'request-promise-native';
import qs from 'querystring';
import { requestTokenRegistry } from './requestTokenRegistry';
import { getEnv } from '../../env';

const consumerKey = getEnv('OAUTH_CONSUMER_KEY');

const consumerSecret = getEnv('OAUTH_CONSUMER_SECRET');

const webBaseUrl = getEnv('WEB_BASE_URL');

export function attachLoginHandler(router: Router) {
  router.post(
    '/login',
    // TODO validation
    async (ctx) => {
      const body = await rp.post({
        url: 'https://www.openstreetmap.org/oauth/request_token',
        oauth: {
          callback: `${webBaseUrl}/authCallback.html`,
          consumer_key: consumerKey,
          consumer_secret: consumerSecret,
        },
      });

      const reqData = qs.parse(body);

      requestTokenRegistry.set(
        reqData.oauth_token as string,
        reqData.oauth_token_secret as string,
      );

      ctx.body = {
        redirect: `https://www.openstreetmap.org/oauth/authorize?${qs.stringify(
          { oauth_token: reqData.oauth_token },
        )}`,
      };
    },
  );
}
