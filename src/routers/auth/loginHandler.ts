import Router from '@koa/router';
import rp from 'request-promise-native';
import qs from 'querystring';
import config from 'config';
import requestTokenRegistry from './requestTokenRegistry';

const consumerKey = config.get('oauth.consumerKey') as string;
const consumerSecret = config.get('oauth.consumerSecret') as string;
const webBaseUrl = config.get('webBaseUrl') as string;

export function attachLoginHandler(router: Router) {
  router.post(
    '/login',
    // TODO validation
    async ctx => {
      const body = await rp.post({
        url: 'https://www.openstreetmap.org/oauth/request_token',
        oauth: {
          callback: `${webBaseUrl}/authCallback.html`,
          consumer_key: consumerKey,
          consumer_secret: consumerSecret,
        },
      });

      const reqData = qs.parse(body);

      requestTokenRegistry.set(reqData.oauth_token, reqData.oauth_token_secret);

      ctx.body = {
        redirect: `https://www.openstreetmap.org/oauth/authorize?${qs.stringify(
          { oauth_token: reqData.oauth_token },
        )}`,
      };
    },
  );
}
