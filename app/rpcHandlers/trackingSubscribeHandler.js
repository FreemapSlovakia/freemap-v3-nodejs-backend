const trackRegister = require('~/trackRegister');
const { pool } = require('~/database');

module.exports = (ctx) => {
  // TODO validate ctx.params
  const { token, fromTime, maxCount, maxAge, deviceId } = ctx.params;

  (async () => {
    const db = await pool.getConnection();

    const { user } = ctx.ctx;

    async function isDeviceOwner() {
      const [row] = await db.query('SELECT userId FROM trackingDevice WHERE deviceId = ?', [deviceId]);
      return row && row.userId === user.id;
    }

    try {
      if (!token && deviceId) {
        if (!user || !user.isAdmin && !await isDeviceOwner()) {
          ctx.respondError(403, 'forbidden');
          return;
        }
      }

      let websockets = trackRegister.get(token || deviceId);
      if (!websockets) {
        websockets = new Set();
        trackRegister.set(token || deviceId, websockets);
      }

      websockets.add(ctx.ctx.websocket);

      const params = [token || deviceId];
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
          `SELECT id, lat, lon, note, createdAt
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
          `SELECT trackingPoint.id, lat, lon, note, trackingPoint.createdAt
            FROM trackingPoint JOIN trackingAccessToken
              ON trackingPoint.deviceId = trackingAccessToken.deviceId
            WHERE trackingAccessToken.deviceId = ?
              ${fromTime ? 'AND TIMESTAMPDIFF(SECOND, trackingPoint.createdAt, now()) < ?' : ''}
              ${maxAge ? 'AND trackingPoint.createdAt >= ?' : ''}
              AND (timeFrom IS NULL OR trackingPoint.createdAt >= timeFrom)
              AND (timeTo IS NULL OR trackingPoint.createdAt < timeTo)
            ORDER BY trackingPoint.id
            ${maxCount ? 'LIMIT ?' : ''}`,
          params,
        );
      }

      ctx.respondResult(result.map(item => ({
        id: item.id,
        lat: item.lat,
        lon: item.lon,
        note: item.note,
        ts: item.createdAt,
      })));
    } finally {
      pool.releaseConnection(db);
    }
  })().catch((err) => {
    ctx.respondError(500, err.message);
  });
};
