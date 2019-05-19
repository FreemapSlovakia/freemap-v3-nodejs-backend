const trackRegister = require('~/trackRegister');
const { pool } = require('~/database');

module.exports = (ctx) => {
  // TODO validate ctx.params
  const { token, deviceId, fromTime, maxCount, maxAge } = ctx.params;

  (async () => {
    const db = await pool.getConnection();

    const { user } = ctx.ctx.state || {};

    try {
      if (deviceId) {
        const [row] = await db.query('SELECT userId FROM trackingDevice WHERE id = ?', [deviceId]);
        if (!row) {
          ctx.respondError(404, 'no such device');
          return;
        }

        if (!user || !user.isAdmin && row.userId !== user.id) {
          ctx.respondError(403, 'forbidden');
          return;
        }
      } else if (token) {
        const [row] = await db.query('SELECT 1 FROM trackingAccessToken WHERE token = ?', token);
        if (!row) {
          ctx.respondError(404, 'no such token');
          return;
        }
      }

      // TODO check if token exists

      let websockets = trackRegister.get(deviceId || token);
      if (!websockets) {
        websockets = new Set();
        trackRegister.set(deviceId || token, websockets);
      }

      websockets.add(ctx.ctx.websocket);

      const params = [deviceId || token];
      if (fromTime) {
        params.push(new Date(fromTime));
      }
      if (maxAge) {
        params.push(Number.parseInt(maxAge, 10));
      }
      if (maxCount) {
        params.push(Number.parseInt(maxCount, 10));
      }

      let result;

      if (maxCount === 0 || maxAge === 0) {
        result = [];
      } else if (deviceId) {
        result = await db.query(
          `SELECT id, lat, lon, message, createdAt, altitude, speed, accuracy, bearing, battery, gsmSignal
            FROM trackingPoint
            WHERE deviceId = ?
              ${fromTime ? 'AND createdAt >= ?' : ''}
              ${maxAge ? 'AND trackingPoint.createdAt >= ?' : ''}
            ORDER BY id
            ${maxCount ? 'LIMIT ?' : ''}`,
          params,
        );
      } else {
        result = await db.query(
          `SELECT trackingPoint.id, lat, lon, message, trackingPoint.createdAt, altitude, speed, accuracy, bearing, battery, gsmSignal
            FROM trackingPoint JOIN trackingAccessToken
              ON trackingPoint.deviceId = trackingAccessToken.deviceId
            WHERE trackingAccessToken.token = ?
              ${maxAge ? 'AND TIMESTAMPDIFF(SECOND, trackingPoint.createdAt, now()) < ?' : ''}
              ${fromTime ? 'AND trackingPoint.createdAt >= ?' : ''}
              AND (timeFrom IS NULL OR trackingPoint.createdAt >= timeFrom)
              AND (timeTo IS NULL OR trackingPoint.createdAt < timeTo)
            ORDER BY trackingPoint.id
            ${maxCount ? 'LIMIT ?' : ''}`,
          params,
        );
      }

      // TODO skip nulls

      ctx.respondResult(result.map(item => ({
        id: item.id,
        ts: item.createdAt,
        lat: item.lat,
        lon: item.lon,
        message: ntu(item.message),
        altitude: ntu(item.altitude),
        speed: ntu(item.speed),
        accuracy: ntu(item.accuracy),
        bearing: ntu(item.bearing),
        battery: ntu(item.battery),
        gsmSignal: ntu(item.gsmSignal),
        [token ? 'token' : 'deviceId']: deviceId || token,
      })));
    } finally {
      pool.releaseConnection(db);
    }
  })().catch((err) => {
    ctx.respondError(500, err.message);
  });
};

function ntu(x) {
  return x === null ? undefined : x;
}
