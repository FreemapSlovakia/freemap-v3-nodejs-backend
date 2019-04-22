const uuidBase62 = require('uuid-base62');
const { dbMiddleware } = require('~/database');
const { acceptValidator } = require('~/requestValidators');
const authenticator = require('~/authenticator');

module.exports = (router) => {
  router.post(
    '/devices',
    acceptValidator('application/json'),
    // TODO bodySchemaValidator(postDeviceSchema, true),
    dbMiddleware(),
    authenticator(true),
    async (ctx) => {
      const token = uuidBase62.v4();

      const { name, maxCount, maxAge } = ctx.request.body;

      const { insertId } = await ctx.state.db.query(
        'INSERT INTO trackingDevice (name, token, userId, maxCount, maxAge) VALUES (?, ?, ?, ?, ?)',
        [name, token, ctx.state.user.id, maxCount, maxAge],
      );

      ctx.body = { id: insertId, token };
    },
  );
};
