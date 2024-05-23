import { RpcContext } from '../rpcHandlerTypes.js';

export function pingHandler(ctx: RpcContext) {
  ctx.respondResult(null);
}
