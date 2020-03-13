const SQL = require('sql-template-strings');
const { dbMiddleware } = require('~/database');
const { acceptValidator } = require('~/requestValidators');
const authenticator = require('~/authenticator');

module.exports = router => {
  router.delete(
    '/access-tokens/:id',
    acceptValidator('application/json'),
    dbMiddleware(),
    authenticator(true),
    async ctx => {
      const [item] = await ctx.state.db.query(SQL`
        SELECT userId FROM trackingAccessToken
          JOIN trackingDevice ON (deviceId = trackingDevice.id)
          WHERE trackingAccessToken.id = ${ctx.params.id} FOR UPDATE
      `);

      if (!item) {
        ctx.throw(404);
      }

      if (!ctx.state.user.isAdmin && item.userId !== ctx.state.user.id) {
        ctx.throw(403);
      }

      await ctx.state.db.query(
        SQL`DELETE FROM trackingAccessToken WHERE id = ${ctx.params.id}`,
      );

      ctx.status = 204;
    },
  );
};
