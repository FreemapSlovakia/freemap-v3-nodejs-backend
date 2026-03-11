import z from 'zod';
import { RpcContext } from '../rpcHandlerTypes.js';
import { trackRegister } from '../trackRegister.js';

export const UnsubscribeParamsSchema = z.union([
  z.strictObject({ token: z.string() }),
  z.strictObject({ deviceId: z.uint32() }),
]);

export type UnsubscribeParams = z.infer<typeof UnsubscribeParamsSchema>;

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
