const rp = require('request-promise-native');
const qs = require('querystring');
const config = require('config');

const consumerKey = config.get('oauth.consumerKey');
const consumerSecret = config.get('oauth.consumerSecret');
const callback = config.get('oauth.callback');

module.exports = function attachLoginHandler(router) {
  router.post(
    '/login',
    // TODO validation
    async (ctx) => {
      const body = await rp.post({
        url: 'http://www.openstreetmap.org/oauth/request_token',
        oauth: {
          callback,
          consumer_key: consumerKey,
          consumer_secret: consumerSecret,
        },
      });

      const reqData = qs.parse(body);
      global.oauth_token_secret = reqData.oauth_token_secret; // TODO store to DB under session
      ctx.body = {
        redirect: `http://www.openstreetmap.org/oauth/authorize?${qs.stringify({ oauth_token: reqData.oauth_token })}`,
      };
    },
  );
};
