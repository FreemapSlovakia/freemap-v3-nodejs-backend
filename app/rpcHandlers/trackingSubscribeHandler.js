const trackRegister = require('~/trackRegister');
const { pool } = require('~/database');

module.exports = (ctx) => {
  const { token, minTime, maxCount } = ctx.params;

  let websockets = trackRegister.get(token);
  if (!websockets) {
    websockets = new Set();
    trackRegister.add(token, websockets);
  }

  websockets.add(ctx.websocket);

  (async () => {
    const db = await pool.getConnection();
    try {
      const params = [token];
      if (minTime) {
        params.push(new Date(minTime));
      }
      if (maxCount) {
        params.push(Number.parseInt(maxCount, 10));
      }

      const result = maxCount === 0 ? [] : await db.query(
        `SELECT trackingPoint.id, lat, lon, createdAt
          FROM trackingPoint JOIN trackingAccessTokens ON trackingPoint.deviceId = trackingAccessTokens.deviceId
          WHERE token = ? AND ${minTime ? 'AND createdAt >= ?' : ''}
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
