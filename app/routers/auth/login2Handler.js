const uuidBase62 = require('uuid-base62');
const rp = require('request-promise-native');
const qs = require('querystring');
const config = require('config');
const { parseString } = require('xml2js');
const { promisify } = require('util');
const { dbMiddleware } = require('~/database');

const parseStringAsync = promisify(parseString);

const consumerKey = config.get('oauth.consumerKey');
const consumerSecret = config.get('oauth.consumerSecret');

module.exports = function attachLogin2Handler(router) {
  router.post(
    '/login2',
    // TODO validation
    dbMiddleware,
    async (ctx) => {
      const body = await rp.post({
        url: 'http://www.openstreetmap.org/oauth/access_token',
        oauth: {
          consumer_key: consumerKey,
          consumer_secret: consumerSecret,
          token: ctx.request.body.token,
          token_secret: global.oauth_token_secret, // TODO read from session
          verifier: ctx.request.body.verifier,
        },
      });

      const permData = qs.parse(body);

      const body2 = await rp.get({
        url: 'http://api.openstreetmap.org/api/0.6/user/details',
        oauth: {
          consumer_key: consumerKey,
          consumer_secret: consumerSecret,
          token: permData.oauth_token,
          token_secret: permData.oauth_token_secret,
        },
      });

      const result = await parseStringAsync(body2);

      ctx.body = result;

      const now = new Date();

      const { display_name: name, id: osmId, lat, lon } = result.osm.home[0].$;

      // TODO only if logged for the fist time
      const { insertId } = await ctx.state.db.query(
        'INSERT INTO user (name, createdAt, lat, lon) VALUES (?, ?, ?, ?, ?, ?, ?, )',
        [name, now, lat, lon],
      );

      const authToken = uuidBase62.v4(); // TODO rather some crypro securerandom

      await ctx.state.db.query(
        'INSERT INTO auth (userId, createdAt, authToken, osmId, osmAuthToken, osmAuthTokenSecret) VALUES (?, ?, ?, ?, ?, ?)',
        [insertId, now, authToken, osmId, permData.oauth_token, permData.oauth_token_secret],
      );

      ctx.body = { authToken, name, lat, lon };
    },
  );
};
