const uuidBase62 = require('uuid-base62');
const { dbMiddleware } = require('~/database');
const fb = require('~/fb');

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
        // eslint-disable-next-line
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
