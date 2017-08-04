const uuidBase62 = require('uuid-base62');
const rp = require('request-promise-native');
const qs = require('querystring');
const config = require('config');
const { parseString } = require('xml2js');
const { promisify } = require('util');
const { dbMiddleware } = require('~/database');
const requestTokenRegistry = require('./requestTokenRegistry');

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
          token_secret: requestTokenRegistry.get(ctx.request.body.token),
          verifier: ctx.request.body.verifier,
        },
      });

      const permData = qs.parse(body);

      const userDetails = await rp.get({
        url: 'http://api.openstreetmap.org/api/0.6/user/details',
        oauth: {
          consumer_key: consumerKey,
          consumer_secret: consumerSecret,
          token: permData.oauth_token,
          token_secret: permData.oauth_token_secret,
        },
      });

      const result = await parseStringAsync(userDetails);

      const { $: { display_name: name, id: osmId }, home: [{ $: { lat, lon } }] } = result.osm.user[0];

      const { db } = ctx.state;

      const users = await db.query('SELECT id FROM user WHERE osmId = ?', [osmId]);

      const now = new Date();

      let userId;
      if (users.length) {
        userId = users[0].id;
        // TODO update name (and ensure osmId is the same)
      } else {
        userId = (await db.query(
          'INSERT INTO user (osmId, name, createdAt) VALUES (?, ?, ?)',
          [osmId, name, now],
        )).insertId;
      }

      const authToken = uuidBase62.v4(); // TODO rather some crypro securerandom

      await db.query(
        'INSERT INTO auth (userId, createdAt, authToken, osmAuthToken, osmAuthTokenSecret) VALUES (?, ?, ?, ?, ?)',
        [userId, now, authToken, permData.oauth_token, permData.oauth_token_secret],
      );

      ctx.body = { authToken, name, lat, lon };
    },
  );
};
