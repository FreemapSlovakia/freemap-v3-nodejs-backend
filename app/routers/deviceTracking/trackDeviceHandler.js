const { dbMiddleware } = require('~/database');
const trackRegister = require('~/trackRegister');

module.exports = (router) => {
  for (const method of ['post', 'get']) {
    router[method](
      '/track/:token',
      dbMiddleware(),
      handler,
    );
  }
};

async function handler(ctx) {
  const [item] = await ctx.state.db.query(
    'SELECT id, maxCount, maxAge FROM trackingDevice WHERE token = ?',
    [ctx.params.token],
  );
  if (!item) {
    ctx.status = 404;
  } else {
    const { lat, lon, alt: altitude, speed, acc: accuracy, bearing, battery, gsm_signal: gsmSignal, message } = ctx.request.body || ctx.request.query;
    const now = new Date();
    const { id, maxAge, maxCount } = item;

    const { insertId } = await ctx.state.db.query(
      `INSERT INTO trackingPoint (deviceId, lat, lon, altitude, speed, accuracy, bearing, battery, gsmSignal, message, createdAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, lat, lon, altitude, speed, accuracy, bearing, battery, gsmSignal, message, now],
    );

    if (maxAge) {
      await ctx.state.db.query(
        'DELETE FROM trackingPoint WHERE deviceId = ? AND TIMESTAMPDIFF(SECOND, createdAt, now()) > ?',
        [id, maxAge],
      );
    }

    if (maxCount) {
      await ctx.state.db.query(
        'DELETE t FROM trackingPoint AS t JOIN (SELECT id FROM trackingPoint WHERE deviceId = ? ORDER BY id DESC OFFSET ?) tlimit ON t.id = tlimit.id',
        [id, maxCount + 1],
      );
    }

    const rows = await ctx.state.db.query(
      'SELECT token FROM trackingAccessToken WHERE deviceId = ? AND (timeFrom IS NULL OR timeFrom > ?) AND (timeTo IS NULL OR timeTo < ?)',
      [id, now, now],
    );

    const notify = (type, key) => {
      const websockets = trackRegister.get(key);
      if (websockets) {
        for (const ws of websockets) {
          ws.send(JSON.stringify({
            jsonrpc: '2.0',
            method: 'tracking.addPoint',
            params: {
              id: insertId, lat, lon, altitude, speed, accuracy, bearing, battery, gsmSignal, message, [type]: key, ts: now.toISOString(),
            },
          }));
        }
      }
    };

    for (const { token } of rows) {
      notify('token', token);
    }
    notify('deviceId', id);

    ctx.body = { id: insertId };
  }
};
