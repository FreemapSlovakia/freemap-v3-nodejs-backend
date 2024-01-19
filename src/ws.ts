import Router from '@koa/router';
import { trackRegister } from './trackRegister';
import { authenticator } from './authenticator';
import { trackingSubscribeHandler } from './rpcHandlers/trackingSubscribeHandler';
import { trackingUnsubscribeHandler } from './rpcHandlers/trackingUnsubscribeHandler';
import { pingHandler } from './rpcHandlers/pingHandler';
import KoaWebsocket from 'koa-websocket';
import * as ws from 'ws';
import { RpcContext } from './rpcHandlerTypes';

export function attachWs(app: KoaWebsocket.App) {
  const wsRouter = new Router();

  wsRouter.all('/ws', authenticator(), async (ctx) => {
    const { pingInterval } = ctx.query;

    const ws = ctx.websocket as ws;

    const pinger = !pingInterval
      ? null
      : setInterval(() => {
          if (ws.readyState === 1) {
            ws.send('ping');
          }
        }, 30000);

    ws.on('message', (message) => {
      let id: number | string | null = null;

      function respondError(code: number, msg: string) {
        if (ws.readyState === 1) {
          ws.send(
            JSON.stringify({
              jsonrpc: '2.0',
              id,
              error: {
                code,
                message: msg,
              },
            }),
          );
        }
      }

      function respondResult(result: any) {
        if (ws.readyState === 1) {
          ws.send(
            JSON.stringify({
              jsonrpc: '2.0',
              id,
              result,
            }),
          );
        }
      }

      let msg;

      try {
        if (message instanceof Buffer) {
          msg = message.toJSON();
        } else if (typeof message === 'string') {
          msg = JSON.parse(message);
        } else {
          throw new Error();
        }
      } catch (err) {
        respondError(-32700, 'Parse error');
        return;
      }

      if (
        msg.jsonrpc !== '2.0' ||
        typeof msg.method !== 'string' ||
        ('id' in msg && !['string', 'number'].includes(typeof msg.id))
      ) {
        respondError(-32600, 'Invalid Request');
        return;
      }

      id = msg.id;

      const rpcCtx: RpcContext = {
        respondResult,
        respondError,
        params: msg.params,
        ctx,
      };

      if (msg.method === 'tracking.subscribe') {
        trackingSubscribeHandler(rpcCtx);
      } else if (msg.method === 'tracking.unsubscribe') {
        trackingUnsubscribeHandler(rpcCtx);
      } else if (msg.method === 'ping') {
        pingHandler(rpcCtx);
      } else {
        respondError(-32601, 'Method not found');
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

  app.ws.use(wsRouter.routes() as any).use(wsRouter.allowedMethods() as any);
}
