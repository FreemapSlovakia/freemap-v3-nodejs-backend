import Router from '@koa/router';
import KoaWebsocket from 'koa-websocket';
import { is } from 'typia';
import type WebSocket from 'ws';
import { authenticator } from './authenticator.js';
import { pingHandler } from './rpcHandlers/pingHandler.js';
import {
  SubscribeParams,
  trackingSubscribeHandler,
} from './rpcHandlers/trackingSubscribeHandler.js';
import {
  trackingUnsubscribeHandler,
  UnsubscribeParams,
} from './rpcHandlers/trackingUnsubscribeHandler.js';
import { RpcContext } from './rpcHandlerTypes.js';
import { trackRegister } from './trackRegister.js';

export function attachWs(app: KoaWebsocket.App) {
  const wsRouter = new Router();

  wsRouter.all('/ws', authenticator(), async (ctx) => {
    console.log('WebSocket connection established');

    const { pingInterval } = ctx.query;

    const ws = ctx.websocket as WebSocket;

    const pinger = !pingInterval
      ? null
      : setInterval(() => {
          if (ws.readyState === 1) {
            ws.send('ping');
          }
        }, 30000);

    ws.on('message', (message) => {
      let id: number | string | null | undefined = undefined;

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

      function respondResult(result: unknown) {
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
          msg = JSON.parse(message.toString('utf-8'));
        } else if (typeof message === 'string') {
          msg = JSON.parse(message);
        } else {
          throw new Error();
        }
      } catch {
        respondError(-32700, 'Parse error');
        return;
      }

      type Request = {
        jsonrpc: '2.0';
        method: string;
        id?: string | number | null;
        params?: unknown;
      };

      type KnownRequest =
        | {
            method: 'tracking.subscribe';
            params: SubscribeParams;
          }
        | {
            method: 'tracking.unsubscribe';
            params: UnsubscribeParams;
          }
        | {
            method: 'ping';
          };

      if (!is<Request>(msg)) {
        respondError(-32600, 'Invalid Request');
        return;
      }

      id = msg.id;

      if (!is<Pick<KnownRequest, 'method'>>(msg)) {
        respondError(-32601, 'Method not found');
        return;
      }

      if (!is<KnownRequest>(msg)) {
        respondError(-32602, 'Invalid params');
        return;
      }

      const rpcCtx: RpcContext = {
        respondResult,
        respondError,
        ctx,
      };

      switch (msg.method) {
        case 'tracking.subscribe':
          trackingSubscribeHandler(rpcCtx, msg.params);
          break;
        case 'tracking.unsubscribe':
          trackingUnsubscribeHandler(rpcCtx, msg.params);
          break;
        case 'ping':
          pingHandler(rpcCtx);
          break;
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.ws.use(wsRouter.routes() as any).use(wsRouter.allowedMethods() as any);
}
