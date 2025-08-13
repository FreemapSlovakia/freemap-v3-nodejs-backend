import { tags } from 'typia';
import { RpcContext } from '../rpcHandlerTypes.js';
import { trackRegister } from '../trackRegister.js';

export type UnsubscribeParams =
  | { token: string }
  | { deviceId: number & tags.Type<'uint32'> };

export function trackingUnsubscribeHandler(
  ctx: RpcContext,
  params: UnsubscribeParams,
) {
  const key = 'token' in params ? params.token : params.deviceId;

  const websockets = trackRegister.get(key);

  if (websockets) {
    websockets.delete(ctx.ctx.websocket);

    if (websockets.size === 0) {
      trackRegister.delete(key);
    }
  }

  ctx.respondResult(null);
}
