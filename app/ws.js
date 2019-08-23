const Router = require('koa-router');
const trackRegister = require('~/trackRegister');
const authenticator = require('~/authenticator');
const trackingSubscribeHandler = require('~/rpcHandlers/trackingSubscribeHandler');
const trackingUnsubscribeHandler = require('~/rpcHandlers/trackingUnsubscribeHandler');
const pingHandler = require('~/rpcHandlers/pingHandler');
const { dbMiddleware } = require('~/database');

module.exports = app => {
  const wsRouter = new Router();

  wsRouter.all('/ws', dbMiddleware(), authenticator(), async ctx => {
    const { pingInterval } = ctx.query;

    const ws = ctx.websocket;

    const pinger = !pingInterval
      ? null
      : setInterval(() => {
          if (ws.readyState === 1) {
            ws.send('ping');
          }
        }, 30000);

    ws.on('message', message => {
      let id = null;

      function respondError(code, msg) {
        if (ws.readyState === 1) {
          ws.send(
            JSON.stringify({
              jsonrpc: '2.0',
              id,
              error: {
                code,
                message: msg
              }
            })
          );
        }
      }

      function respondResult(result) {
        if (ws.readyState === 1) {
          ws.send(
            JSON.stringify({
              jsonrpc: '2.0',
              id,
              result
            })
          );
        }
      }

      let msg;

      try {
        msg = JSON.parse(message);
      } catch (err) {
        respondError(-32700);
        return;
      }

      if (
        msg.jsonrpc !== '2.0' ||
        typeof msg.method !== 'string' ||
        ('id' in msg && !['string', 'number'].includes(typeof msg.id))
      ) {
        respondError(-32600);
        return;
      }

      id = msg.id;

      const rpcCtx = {
        respondResult,
        respondError,
        params: msg.params,
        ctx
      };

      if (msg.method === 'tracking.subscribe') {
        trackingSubscribeHandler(rpcCtx);
      } else if (msg.method === 'tracking.unsubscribe') {
        trackingUnsubscribeHandler(rpcCtx);
      } else if (msg.method === 'ping') {
        pingHandler(rpcCtx);
      } else {
        respondError(-32601);
      }
    });

    const handleCloseOrError = () => {
      if (pinger) {
        clearTimeout(pinger);
      }
      for (const websockets of trackRegister.values()) {
        websockets.delete(ws);
      }
    };

    ws.on('close', handleCloseOrError);
    ws.on('error', handleCloseOrError);
  });

  app.ws.use(wsRouter.routes()).use(wsRouter.allowedMethods());
};
