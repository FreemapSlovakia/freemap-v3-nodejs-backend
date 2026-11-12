import z from 'zod';
import type { RpcContext } from '../rpcHandlerTypes.js';
import { removeTrackListener } from '../trackRegister.js';

export const UnsubscribeParamsSchema = z.union([
  z.strictObject({ token: z.string() }),
  z.strictObject({ deviceId: z.uint32() }),
]);

export type UnsubscribeParams = z.infer<typeof UnsubscribeParamsSchema>;

export function trackingUnsubscribeHandler(
  ctx: RpcContext,
  params: UnsubscribeParams,
) {
  removeTrackListener(
    'token' in params ? params.token : params.deviceId,
    ctx.listener,
  );

  ctx.respondResult(null);
}
