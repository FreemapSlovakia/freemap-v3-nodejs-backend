const uuidBase62 = require('uuid-base62');
const { dbMiddleware } = require('~/database');
const { acceptValidator } = require('~/requestValidators');
const authenticator = require('~/authenticator');

module.exports = (router) => {
  router.post(
    '/devices',
    acceptValidator('application/json'),
    // TODO bodySchemaValidator(postDeviceSchema, true),
    dbMiddleware,
    authenticator(true),
    async (ctx) => {
      const token = uuidBase62.v4();

      const { insertId } = await ctx.state.db.query(
        'INSERT INTO trackingDevice (name, token, userId) VALUES (?, ?, ?)',
        [ctx.request.body.name, token, ctx.state.user.id],
      );

      ctx.body = { id: insertId, token };
    },
  );
};
