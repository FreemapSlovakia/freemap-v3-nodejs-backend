const { dbMiddleware } = require('~/database');
const { acceptValidator } = require('~/requestValidators');
const authenticator = require('~/authenticator');


module.exports = (router) => {
  router.delete(
    '/track/:accessToken',
    acceptValidator('application/json'),
    dbMiddleware,
    authenticator(true),
    async (ctx) => {
      const [item] = await ctx.state.db.query(
        'SELECT id FROM trackingDevice WHERE token = ?',
        [ctx.params.id],
      );
      if (!item) {
        ctx.status = 404;
      } else if (!ctx.state.user.isAdmin && item.userId !== ctx.state.user.id) {
        ctx.status = 403;
      } else {
        const { lat, lon, note } = ctx.request.body;
        const { insertId } = await ctx.state.db.query(
          'INSERT INTO trackingPoint (deviceId, lat, lon, note) VALUES (?, ?, ?, ?)',
          [item.id, lat, lon, note],
        );

        ctx.body = { id: insertId };
      }
    },
  );
};
