import type WebSocket from 'ws';
import type { RpcContext } from '../rpcHandlerTypes.js';
import {
  checkTrackingAccess,
  queryTrackPoints,
  type SubscribeParams,
  subscriptionKey,
} from '../trackingSubscription.js';
import { addTrackListener } from '../trackRegister.js';

export function trackingSubscribeHandler(
  ctx: RpcContext,
  params: SubscribeParams,
) {
  (async () => {
    const refusal = await checkTrackingAccess(ctx.ctx.state?.user, params);

    if (refusal) {
      ctx.respondError(
        refusal,
        refusal === 404 ? 'no such device or token' : 'forbidden',
      );

      return;
    }

    // A listener added after the close would never be removed.
    if ((ctx.ctx.websocket as WebSocket).readyState !== 1) {
      return;
    }

    addTrackListener(subscriptionKey(params), ctx.listener);

    ctx.respondResult(await queryTrackPoints(params));
  })().catch((err) => {
    ctx.respondError(500, err.message);
  });
}
