const uuidBase62 = require('uuid-base62');
const { dbMiddleware } = require('~/database');
const { acceptValidator } = require('~/requestValidators');
const authenticator = require('~/authenticator');

module.exports = (router) => {
  router.post(
    '/devices/:id',
    acceptValidator('application/json'),
    // TODO bodySchemaValidator(putDeviceSchema, true),
    dbMiddleware(),
    authenticator(true),
    async (ctx) => {
      const [item] = await ctx.state.db.query(
        'SELECT userId FROM trackingDevice WHERE id = ?',
        [ctx.request.body.name, ctx.params.id],
      );

      if (!item) {
        ctx.status = 404;
      } else if (!ctx.state.user.isAdmin && item.userId !== ctx.state.user.id) {
        ctx.status = 403;
      } else {
        const { name, maxCount, maxAge, regenerateToken } = ctx.request.body;
        let token;

        if (regenerateToken) {
          token = uuidBase62.v4();
        }

        await ctx.state.db.query(
          `UPDATE trackingDevice SET name = ?, maxCount = ?, maxAge = ?${regenerateToken ? ', token = ?' : ''} WHERE id = ?`,
          [name, maxCount, maxAge, ...regenerateToken ? [token] : [], ctx.params.id],
        );

        if (maxAge) {
          await ctx.state.db.query(
            'DELETE FROM trackingPoint WHERE deviceId = ? AND TIMESTAMPDIFF(SECOND(createdAt, now())) > ?',
            [ctx.params.id, maxAge],
          );
        }

        if (maxCount) {
          await ctx.state.db.query(
            'DELETE t FROM trackingPoint AS t JOIN (SELECT id FROM trackingPoint WHERE deviceId = ? ORDER BY id DESC OFFSET ?) tlimit ON t.id = tlimit.id',
            [ctx.params.id, maxCount + 1],
          );
        }

        ctx.body = { token };
      }
    },
  );
};
