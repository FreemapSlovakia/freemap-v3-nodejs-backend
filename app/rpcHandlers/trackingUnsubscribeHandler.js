const trackRegister = require('~/trackRegister');

module.exports = (ctx) => {
  const { token, deviceId } = ctx.params;

  function rm(key) {
    const websockets = trackRegister.get(key);
    if (websockets) {
      websockets.delete(ctx.websocket);
    }

    if (websockets.size === 0) {
      trackRegister.delete(key);
    }
  }

  if (token) {
    rm(token);
  }

  if (deviceId) {
    rm(deviceId);
  }

  ctx.respondResult(null);
};
