const uuidBase62 = require('uuid-base62');
const { dbMiddleware } = require('~/database');
const { verifyIdToken, clientId } = require('~/google');

module.exports = function attachLoginWithFacebookHandler(router) {
  router.post(
    '/login-google',
    // TODO validation
    dbMiddleware,
    async (ctx) => {
      /* eslint-disable prefer-destructuring */

      const { idToken } = ctx.request.body;

      const payload = (await verifyIdToken(idToken, clientId)).getPayload(); // TODO catch error

      const { db } = ctx.state;

      const users = await db.query('SELECT id, name FROM user WHERE googleUserId = ?', [payload.sub]);

      const now = new Date();

      let userId;
      let name;
      if (users.length) {
        userId = users[0].id;
        name = users[0].name;
      } else {
        userId = (await db.query(
          'INSERT INTO user (googleUserId, name, email, createdAt) VALUES (?, ?, ?, ?)',
          [payload.sub, payload.name, payload.email, now],
        )).insertId;
        name = payload.name;
      }

      const authToken = uuidBase62.v4(); // TODO rather some crypro securerandom

      await db.query(
        'INSERT INTO auth (userId, createdAt, authToken, googleIdToken) VALUES (?, ?, ?, ?)',
        [userId, now, authToken, idToken],
      );

      ctx.body = { id: userId, authToken, name };
    },
  );
};
