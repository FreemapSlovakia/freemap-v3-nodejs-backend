const Router = require('koa-router');
const trackRegister = require('~/trackRegister');
const authenticator = require('~/authenticator');
const trackingSubscribeHandler = require('~/rpcHandlers/trackingSubscribeHandler');
const trackingUnsubscribeHandler = require('~/rpcHandlers/trackingUnsubscribeHandler');

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

      const rpcCtx = {
        respondResult,
        respondError,
        params: msg.params,
        user: ctx.user,
      };

      if (msg.method === 'tracking.subscribe') {
        trackingSubscribeHandler(rpcCtx);
      } else if (msg.method === 'tracking.unsubscribe') {
        trackingUnsubscribeHandler(rpcCtx);
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
