const { dbMiddleware } = require('~/database');
const { acceptValidator } = require('~/requestValidators');
const authenticator = require('~/authenticator');

module.exports = (router) => {
  router.post(
    '/access-tokens/:id',
    acceptValidator('application/json'),
    authenticator(true),
    // TODO bodySchemaValidator(putTokenSchema, true),
    dbMiddleware,
    async (ctx) => {
      const [item] = await ctx.state.db.query(
        `SELECT userId FROM trackingAccessTokens JOIN trackingDevice ON (deviceId = trackingDevice.id)
          WHERE trackingAccessTokens.id = ? AND trackingDevice.id = ? FOR UPDATE`,
        [ctx.params.id],
      );

      if (!item) {
        ctx.status = 404;
      } else if (!ctx.state.user.isAdmin && item.userId !== ctx.state.user.id) {
        ctx.status = 403;
      } else {
        const { validTo, note, listed = false } = ctx.request.body;

        await ctx.state.db.query(
          'UPDATE trackingAccessTokens SET note = ?, validTo = ?, listed = ? WHERE id = ?',
          [note, validTo, listed, ctx.params.id],
        );

        ctx.status = 204;
      }
    },
  );
};
