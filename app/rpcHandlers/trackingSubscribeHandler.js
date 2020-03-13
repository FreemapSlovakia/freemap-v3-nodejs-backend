const SQL = require('sql-template-strings');
const trackRegister = require('~/trackRegister');
const { poolPromise } = require('~/database');

module.exports = ctx => {
  // TODO validate ctx.params
  const { token, deviceId, fromTime, maxCount, maxAge } = ctx.params;

  (async () => {
    const pool = await poolPromise;

    const db = await pool.getConnection();

    const { user } = ctx.ctx.state || {};

    try {
      if (deviceId) {
        const [row] = await db.query(
          SQL`SELECT userId FROM trackingDevice WHERE id = ${deviceId}`,
        );

        if (!row) {
          ctx.throw(404, 'no such device');
        }

        if (!user || (!user.isAdmin && row.userId !== user.id)) {
          ctx.throw(403, 'forbidden');
        }
      } else if (token) {
        const [row] = await db.query(
          SQL`SELECT 1 FROM trackingAccessToken WHERE token = ${token}`,
        );

        if (!row) {
          ctx.throw(404, 'no such token');
        }
      }

      // TODO check if token exists

      let websockets = trackRegister.get(deviceId || token);

      if (!websockets) {
        websockets = new Set();
        trackRegister.set(deviceId || token, websockets);
      }

      websockets.add(ctx.ctx.websocket);

      let result;

      if (maxCount === 0 || maxAge === 0) {
        result = [];
      } else if (deviceId) {
        result = await db.query(
          SQL`SELECT id, lat, lon, message, createdAt, altitude, speed, accuracy, hdop, bearing, battery, gsmSignal
            FROM trackingPoint
            WHERE deviceId = ${deviceId || token}`
            .append(fromTime ? SQL`AND createdAt >= ${new Date(fromTime)}` : '')
            .append(
              maxAge
                ? SQL`AND trackingPoint.createdAt >= ${Number(maxAge)}`
                : '',
            )
            .append('ORDER BY id DESC')
            .append(maxCount ? SQL` LIMIT ${Number(maxCount)}` : ''),
        );
      } else {
        result = await db.query(
          SQL`SELECT trackingPoint.id, lat, lon, message, trackingPoint.createdAt, altitude, speed, accuracy, hdop, bearing, battery, gsmSignal
            FROM trackingPoint JOIN trackingAccessToken
              ON trackingPoint.deviceId = trackingAccessToken.deviceId
              WHERE trackingAccessToken.token = ${deviceId || token}
          `
            .append(
              maxAge
                ? SQL`AND TIMESTAMPDIFF(SECOND, trackingPoint.createdAt, now()) < ${new Date(
                    fromTime,
                  )}`
                : '',
            )
            .append(
              fromTime
                ? SQL`AND trackingPoint.createdAt >= ${Number(maxAge)}`
                : '',
            )
            .append(
              ` AND (timeFrom IS NULL OR trackingPoint.createdAt >= timeFrom)
                AND (timeTo IS NULL OR trackingPoint.createdAt < timeTo)
                ORDER BY trackingPoint.id DESC
              `,
            )
            .append(maxCount ? SQL` LIMIT ${Number(maxCount)}` : ''),
        );
      }

      // TODO skip nulls

      ctx.respondResult(
        result.reverse().map(item => ({
          id: item.id,
          ts: item.createdAt,
          lat: item.lat,
          lon: item.lon,
          message: ntu(item.message),
          altitude: ntu(item.altitude),
          speed: ntu(item.speed),
          accuracy: ntu(item.accuracy),
          hdop: ntu(item.hdop),
          bearing: ntu(item.bearing),
          battery: ntu(item.battery),
          gsmSignal: ntu(item.gsmSignal),
        })),
      );
    } finally {
      pool.releaseConnection(db);
    }
  })().catch(err => {
    ctx.respondError(500, err.message);
  });
};

function ntu(x) {
  return x === null ? undefined : x;
}
