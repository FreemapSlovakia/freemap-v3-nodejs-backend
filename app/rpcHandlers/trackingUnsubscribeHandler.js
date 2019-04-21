const trackRegister = require('~/trackRegister');

module.exports = (ctx) => {
  const { token } = ctx.params;

  const websockets = trackRegister.get(token);
  if (websockets) {
    websockets.delete(ctx.websocket);
  }
  if (websockets.size === 0) {
    trackRegister.delete(token);
  }

  return null;
};
