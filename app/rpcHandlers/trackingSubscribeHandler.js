const trackRegister = require('~/trackRegister');
const { pool } = require('~/database');

module.exports = (ctx) => {
  const { token, minTime, maxCount, deviceId } = ctx.params;

  (async () => {
    const db = await pool.getConnection();

    async function isDeviceOwner() {
      const [row] = await db.query('SELECT userId FROM trackingDevice WHERE deviceId = ?', [deviceId]);
      return row && row.userId === ctx.user.id;
    }

    try {
      if (!token && deviceId) {
        if (!ctx.user || !ctx.user.isAdmin && !await isDeviceOwner()) {
          ctx.respondError(403, 'forbidden');
        }
      }

      let websockets = trackRegister.get(token || deviceId);
      if (!websockets) {
        websockets = new Set();
        trackRegister.add(token, websockets);
      }

      websockets.add(ctx.websocket);

      const params = [token || deviceId];
      if (minTime) {
        params.push(new Date(minTime));
      }
      if (maxCount) {
        params.push(Number.parseInt(maxCount, 10));
      }

      const result = maxCount === 0 ? [] : await db.query(
        `SELECT trackingPoint.id, lat, lon, trackingPoint.createdAt
          FROM trackingPoint JOIN trackingAccessTokens
            ON trackingPoint.deviceId = trackingAccessTokens.deviceId
          WHERE (${token ? 'token' : 'deviceId'} = ?) ${minTime ? 'AND createdAt >= ?' : ''}
            AND (timeFrom IS NULL OR trackingPoint.createdAt >= timeFrom)
            AND (timeTo IS NULL OR trackingPoint.createdAt < timeTo)
          ORDER BY trackingPoint.id
          ${maxCount ? 'LIMIT ?' : ''}`,
        params,
      );

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
