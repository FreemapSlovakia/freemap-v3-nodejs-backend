const Router = require('koa-router');

module.exports = (app) => {
  const wsRouter = new Router();

  wsRouter.all('/ws', async (ctx) => {
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

      if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string' || typeof msg.params !== 'object' || ('id' in msg && !['string', 'number'].includes(typeof msg.id))) {
        respondError(-32600);
        return;
      }

      id = msg.id;

      if (msg.method === 'tracking.subscribe') {
        console.log(msg.params);
        // limitTime
        // limitCount
        // token

        respondResult(null);
      } else {
        respondError(-32601);
      }
    });
  });

  app.ws
    .use(wsRouter.routes())
    .use(wsRouter.allowedMethods());
};
