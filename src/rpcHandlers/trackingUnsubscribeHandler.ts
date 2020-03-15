import trackRegister from '../trackRegister';

export function trackingUnsubscribeHandler(ctx) {
  // TODO validate ctx.params
  const { token, deviceId } = ctx.params;

  function rm(key: string) {
    const websockets = trackRegister.get(key);
    if (websockets) {
      websockets.delete(ctx.ctx.websocket);

      if (websockets.size === 0) {
        trackRegister.delete(key);
      }
    }
  }

  if (token) {
    rm(token);
  }

  if (deviceId) {
    rm(deviceId);
  }

  ctx.respondResult(null);
}
