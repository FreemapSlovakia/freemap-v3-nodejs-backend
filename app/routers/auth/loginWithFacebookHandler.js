const uuidBase62 = require('uuid-base62');
const rp = require('request-promise-native');
const qs = require('querystring');
const config = require('config');
const { parseString } = require('xml2js');
const { promisify } = require('util');
const { dbMiddleware } = require('~/database');
const fb = require('~/fb');
const requestTokenRegistry = require('./requestTokenRegistry');

const parseStringAsync = promisify(parseString);

const consumerKey = config.get('oauth.consumerKey');
const consumerSecret = config.get('oauth.consumerSecret');

module.exports = function attachLoginWithFacebookHandler(router) {
  router.post(
    '/login-fb',
    // TODO validation
    dbMiddleware,
    async (ctx) => {
      const { accessToken } = ctx.request.body;
      const { id, name: fbName, email } = await fb.withAccessToken(accessToken).api('/me', { fields: 'id,name,email' });

      const { db } = ctx.state;

      const users = await db.query('SELECT id, name FROM user WHERE facebookUserId = ?', [id]);

      const now = new Date();

      let userId;
      let name;
      if (users.length) {
        userId = users[0].id;
        name = users[0].name;
      } else {
        userId = (await db.query(
          'INSERT INTO user (facebookUserId, name, email, createdAt) VALUES (?, ?, ?, ?)',
          [id, fbName, email, now],
        )).insertId;
        name = fbName;
      }

      const authToken = uuidBase62.v4(); // TODO rather some crypro securerandom

      await db.query(
        'INSERT INTO auth (userId, createdAt, authToken, facebookAccessToken) VALUES (?, ?, ?, ?)',
        [userId, now, authToken, accessToken],
      );

      ctx.body = { id: userId, authToken, name };
    },
  );
};
