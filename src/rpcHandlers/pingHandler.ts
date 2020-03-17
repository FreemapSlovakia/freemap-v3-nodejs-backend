import { RpcContext } from '../rpcHandlerTypes';

export function pingHandler(ctx: RpcContext) {
  ctx.respondResult(null);
}
