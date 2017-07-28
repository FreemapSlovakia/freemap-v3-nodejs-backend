const rp = require('request-promise-native');
const qs = require('querystring');
const config = require('config');

const consumerKey = config.get('oauth.consumerKey');
const consumerSecret = config.get('oauth.consumerSecret');
const callback = config.get('oauth.callback');

module.exports = function attachLoginHandler(router) {
  router.post(
    '/login',
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

// request.post(
//   {
//     url: 'http://www.openstreetmap.org/oauth/access_token',
//     oauth: {
//       consumer_key: consumerKey,
//       consumer_secret: consumerSecret,
//       token: 'wQLq4546d8Bl6agAxEI5YKGaRNloP6HEfEIy9iiT',
//       token_secret: 'SGcgegjLLnHbQiRqyNfGUFTOcNnkLzIK2zLUAcDH',
//       verifier: 'uq3mEBCxwRxwYb9WjmT6',
//     },
//   },
//   (e, r, body) => {
//     const permData = qs.parse(body);
//     console.log(permData);
//   }
// );

// request.get(
//   {
//     url: 'http://api.openstreetmap.org/api/0.6/user/details',
//     oauth: {
//       consumer_key: consumerKey,
//       consumer_secret: consumerSecret,
//       token: 'LPS1OTaMpmTucbsX6IxPPevQN1GZd3WSDHpgm121',
//       token_secret: 'H7DwhDJCJVZLkHiuQtTwfEPvzKeGNOdR6GpHdgSy',
//     },
//   },
//   (e, r, body) => {
//    console.log('bbbbbbbbbbbbbb', body);
//   },
// );
