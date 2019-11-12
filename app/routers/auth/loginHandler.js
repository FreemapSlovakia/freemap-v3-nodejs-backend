const rp = require('request-promise-native');
const qs = require('querystring');
const config = require('config');
const requestTokenRegistry = require('./requestTokenRegistry');

const consumerKey = config.get('oauth.consumerKey');
const consumerSecret = config.get('oauth.consumerSecret');
const webBaseUrl = config.get('webBaseUrl');

module.exports = function attachLoginHandler(router) {
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
};
