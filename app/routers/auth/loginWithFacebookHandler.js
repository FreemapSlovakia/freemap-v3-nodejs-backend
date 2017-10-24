const uuidBase62 = require('uuid-base62');
const { dbMiddleware } = require('~/database');
const fb = require('~/fb');

module.exports = function attachLoginWithFacebookHandler(router) {
  router.post(
    '/login-fb',
    // TODO validation
    dbMiddleware,
    async (ctx) => {
      /* eslint-disable prefer-destructuring */

      const { accessToken } = ctx.request.body;
      const { id, name: fbName, email: fbEmail } = await fb.withAccessToken(accessToken).api('/me', { fields: 'id,name,email' });

      const { db } = ctx.state;

      const [user] = await db.query('SELECT id, name, email, isAdmin, lat, lon FROM user WHERE facebookUserId = ?', [id]);

      const now = new Date();

      let userId;
      let name;
      let email;
      let isAdmin;
      let lat;
      let lon;
      if (user) {
        ({ name, email, lat, lon } = user);
        userId = user.id;
        isAdmin = !!user.isAdmin;
      } else {
        userId = (await db.query(
          'INSERT INTO user (facebookUserId, name, email, createdAt) VALUES (?, ?, ?, ?)',
          [id, fbName, fbEmail, now],
        )).insertId;
        name = fbName;
        email = fbEmail;
        isAdmin = false;
      }

      const authToken = uuidBase62.v4(); // TODO rather some crypro securerandom

      await db.query(
        'INSERT INTO auth (userId, createdAt, authToken, facebookAccessToken) VALUES (?, ?, ?, ?)',
        [userId, now, authToken, accessToken],
      );

      ctx.body = { id: userId, authToken, name, email, isAdmin, lat, lon };
    },
  );
};
