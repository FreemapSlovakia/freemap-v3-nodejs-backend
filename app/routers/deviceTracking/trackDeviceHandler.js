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
    const altitude = (q.alt || q.altitude) === undefined ? null : Number.parseFloat(q.alt || q.altitude);
    const speedMs = q.speed === undefined ? null : Number.parseFloat(q.speed);
    const speedKmh = q.speedKmh === undefined ? null : Number.parseFloat(q.speedKmh);
    const accuracy = q.acc === undefined ? null : Number.parseFloat(q.acc);
    const hdop = q.hdop === undefined ? null : Number.parseFloat(q.hdop);
    const bearing = q.bearing === undefined ? null : Number.parseFloat(q.bearing);
    const battery = q.battery === undefined ? null : Number.parseFloat(q.battery);
    const gsmSignal = q.gsm_signal === undefined ? null : Number.parseFloat(q.gsm_signal);
    const time = guessTime(q.time || q.timestamp);

    if (time === null
        || Number.isNaN(lat) || lat < -90 || lat > 90 || Number.isNaN(lon) || lon < -180 || lon > 180
        || Number.isNaN(battery) || battery !== null && (battery < 0 || battery > 100)
        || Number.isNaN(gsmSignal) || gsmSignal !== null && (gsmSignal < 0 || gsmSignal > 100)
        || Number.isNaN(bearing) || bearing !== null && (bearing < 0 || bearing > 360)
        || Number.isNaN(accuracy) || accuracy !== null && accuracy < 0
        || Number.isNaN(hdop) || hdop !== null && hdop < 0
        || Number.isNaN(speedMs) || speedMs !== null && speedMs < 0
        || Number.isNaN(speedKmh) || speedKmh !== null && speedKmh < 0
    ) {
      ctx.status = 400;
      return;
    }

    const now = new Date();

    const { id, maxAge, maxCount } = item;

    const speed = typeof speedKmh === 'number' ? speedKmh / 3.6 : speedMs;

    const { insertId } = await ctx.state.db.query(
      `INSERT INTO trackingPoint (deviceId, lat, lon, altitude, speed, accuracy, hdop, bearing, battery, gsmSignal, message, createdAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, lat, lon, altitude, speed, accuracy, hdop, bearing, battery, gsmSignal, message, time],
    );

    if (maxAge) {
      await ctx.state.db.query(
        'DELETE FROM trackingPoint WHERE deviceId = ? AND TIMESTAMPDIFF(SECOND, createdAt, now()) > ?',
        [id, maxAge],
      );
    }

    if (maxCount) {
      await ctx.state.db.query(
        'DELETE t FROM trackingPoint AS t JOIN (SELECT id FROM trackingPoint WHERE deviceId = ? ORDER BY id DESC LIMIT 18446744073709551615 OFFSET ?) tlimit ON t.id = tlimit.id',
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
          if (ws.readyState === 1) {
            ws.send(JSON.stringify({
              jsonrpc: '2.0',
              method: 'tracking.addPoint',
              params: {
                // TODO validate if time matches limits
                id: insertId, lat, lon, altitude, speed, accuracy, hdop, bearing, battery, gsmSignal, message, [type]: key, ts: time.toISOString(),
              },
            }));
          }
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

function guessTime(t) {
  const now = new Date();
  const min = new Date();
  min.setDate(min.getDate() - 2);
  const max = new Date();
  max.setDate(max.getDate() + 1);

  if (!t) {
    return now;
  }

  const d1 = new Date(t);
  if (max > d1 && d1 > min) {
    return d1;
  }

  const n = Number.parseInt(t, 10);
  if (Number.isNaN(n)) {
    return null;
  }

  const d2 = new Date(n);

  if (max > d2 && d2 > min) {
    return d2;
  }

  const d3 = new Date(n * 1000);
  if (max > d3 && d3 > min) {
    return d3;
  }

  return null;
}
