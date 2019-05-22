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
    const q = ctx.method === 'POST' && ctx.request.type === 'application/x-www-form-urlencoded' ? ctx.request.body : ctx.query;

    const { message } = q;

    const lat = Number.parseFloat(q.lat);
    const lon = Number.parseFloat(q.lon);
    const altitude = q.alt === undefined ? null : Number.parseFloat(q.alt);
    const speed = q.speed === undefined ? null : Number.parseFloat(q.speed);
    const accuracy = q.acc === undefined ? null : Number.parseFloat(q.acc);
    const bearing = q.bearing === undefined ? null : Number.parseFloat(q.bearing);
    const battery = q.battery === undefined ? null : Number.parseFloat(q.battery);
    const gsmSignal = q.gsm_signal === undefined ? null : Number.parseFloat(q.gsm_signal);
    const time = guessTime(q.time);

    const now = new Date();

    const { id, maxAge, maxCount } = item;

    const { insertId } = await ctx.state.db.query(
      `INSERT INTO trackingPoint (deviceId, lat, lon, altitude, speed, accuracy, bearing, battery, gsmSignal, message, createdAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, lat, lon, altitude, speed, accuracy, bearing, battery, gsmSignal, message, time],
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
              // TODO validate if time matches limits
              id: insertId, lat, lon, altitude, speed, accuracy, bearing, battery, gsmSignal, message, [type]: key, ts: time.toISOString(),
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
}

const min = new Date('2000-01-01');
const max = new Date('3000-01-01');

function guessTime(t) {
  if (!t) {
    return new Date();
  }

  const d1 = new Date(t);
  if (max > d1 && d1 > min) {
    return d1;
  }

  const n = Number.parseInt(t, 10);
  if (Number.isNaN(n)) {
    return new Date();
  }

  const d2 = new Date(t);
  if (max > d2 && d2 > min) {
    return d2;
  }

  const d3 = new Date(t * 1000);
  if (max > d3 && d3 > min) {
    return d3;
  }

  return new Date();
}
