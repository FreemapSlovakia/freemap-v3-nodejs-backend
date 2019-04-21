const { dbMiddleware } = require('~/database');
const { acceptValidator } = require('~/requestValidators');
const authenticator = require('~/authenticator');
const trackRegister = require('~/trackRegister');

module.exports = (router) => {
  router.post(
    '/track/:token',
    acceptValidator('application/json'),
    dbMiddleware,
    authenticator(true),
    async (ctx) => {
      const [item] = await ctx.state.db.query(
        'SELECT id FROM trackingDevice WHERE token = ?',
        [ctx.params.token],
      );
      if (!item) {
        ctx.status = 404;
      } else if (!ctx.state.user.isAdmin && item.userId !== ctx.state.user.id) {
        ctx.status = 403;
      } else {
        const { lat, lon, note } = ctx.request.body;
        const now = new Date();

        const { insertId } = await ctx.state.db.query(
          'INSERT INTO trackingPoint (deviceId, lat, lon, note, createdAt) VALUES (?, ?, ?, ?, ?)',
          [item.id, lat, lon, note, now],
        );

        const rows = await ctx.state.db.query(
          'SELECT token FROM trackingAccessTokens WHERE deviceId = ? AND validTo > ?',
          [item.id, now],
        );

        for (const { token } of rows) {
          const websockets = trackRegister.get(token);
          if (Array.isArray(websockets)) {
            for (const ws of websockets) {
              ws.send(JSON.stringify({
                jsonrpc: '2.0',
                method: 'tracking.addPoint',
                params: {
                  id: insertId, lat, lon, note, token, ts: now.toISOString(),
                },
              }));
            }
          }
        }

        ctx.body = { id: insertId };
      }
    },
  );
};
