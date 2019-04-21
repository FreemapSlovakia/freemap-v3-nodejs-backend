const Router = require('koa-router');
const trackRegister = require('~/trackRegister');
const { pool } = require('~/database');
const authenticator = require('~/authenticator');

module.exports = (app) => {
  const wsRouter = new Router();

  wsRouter.all('/ws', authenticator(), async (ctx) => {
    ctx.websocket.on('message', (message) => {
      let id = null;

      function respondError(code, msg) {
        ctx.websocket.send(JSON.stringify({
          jsonrpc: '2.0',
          id,
          error: {
            code,
            message: msg,
          },
        }));
      }

      function respondResult(result) {
        ctx.websocket.send(JSON.stringify({
          jsonrpc: '2.0',
          id,
          result,
        }));
      }

      let msg;

      try {
        msg = JSON.parse(message);
      } catch (err) {
        respondError(-32700);
        return;
      }

      if (
        msg.jsonrpc !== '2.0'
        || typeof msg.method !== 'string'
        || typeof msg.params !== 'object'
        || ('id' in msg && !['string', 'number'].includes(typeof msg.id))
      ) {
        respondError(-32600);
        return;
      }

      id = msg.id;

      if (msg.method === 'tracking.subscribe') {
        const { token, minTime, maxCount } = msg.params;

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

            respondResult(result.map(item => ({
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
          respondError(500, err.message);
        });
      } else if (msg.method === 'tracking.unsubscribe') {
        const { token } = msg.params;

        const websockets = trackRegister.get(token);
        if (websockets) {
          websockets.delete(ctx.websocket);
        }
        if (websockets.size === 0) {
          trackRegister.delete(token);
        }

        respondResult(null);
      } else {
        respondError(-32601);
      }
    });

    ctx.websocket.on('close', () => {
      for (const websockets of trackRegister.values()) {
        websockets.delete(ctx.websocket);
      }
    });
  });

  app.ws
    .use(wsRouter.routes())
    .use(wsRouter.allowedMethods());
};
