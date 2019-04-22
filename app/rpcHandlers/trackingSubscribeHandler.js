const trackRegister = require('~/trackRegister');
const { pool } = require('~/database');

module.exports = (ctx) => {
  const { token, minTime, maxCount, deviceId } = ctx.params;

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
      if (minTime) {
        params.push(new Date(minTime));
      }
      if (maxCount) {
        params.push(Number.parseInt(maxCount, 10));
      }

      let result;

      if (maxCount === 0) {
        result = [];
      } else if (deviceId) {
        result = await db.query(
          `SELECT id, lat, lon, note, createdAt
            FROM trackingPoint
            WHERE deviceId = ? ${minTime ? 'AND createdAt >= ?' : ''}
            ORDER BY id
            ${maxCount ? 'LIMIT ?' : ''}`,
          params,
        );
      } else {
        result = await db.query(
          `SELECT trackingPoint.id, lat, lon, note, trackingPoint.createdAt
            FROM trackingPoint JOIN trackingAccessTokens
              ON trackingPoint.deviceId = trackingAccessTokens.deviceId
            WHERE trackingAccessTokens.deviceId = ?
              ${minTime ? 'AND trackingPoint.createdAt >= ?' : ''}
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
