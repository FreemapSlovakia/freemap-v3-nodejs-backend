const uuidBase62 = require('uuid-base62');
const { dbMiddleware } = require('~/database');
const { acceptValidator } = require('~/requestValidators');
const authenticator = require('~/authenticator');

module.exports = (router) => {
  router.post(
    '/devices/:id/access-tokens',
    acceptValidator('application/json'),
    // TODO bodySchemaValidator(postTokenCommentSchema, true),
    dbMiddleware,
    authenticator(true),
    async (ctx) => {
      const [device] = await ctx.state.db.query(
        'SELECT userId FROM trackingDevice WHERE id = ?',
        [ctx.params.id],
      );

      if (!device) {
        ctx.state = 404;
      } else if (!ctx.state.user.isAdmin && ctx.state.user.id !== device.userId) {
        ctx.status = 403;
      } else {
        const token = uuidBase62.v4();
        const { validTo, note, listed = false } = ctx.request.body;

        const { insertId } = await ctx.state.db.query(
          'INSERT INTO trackingAccessToken (deviceId, token, validTo, note, listed) VALUES (?, ?, ?, ?)',
          [ctx.params.id, token, validTo && new Date(validTo), note, listed],
        );

        ctx.body = { id: insertId, token };
      }
    },
  );
};
