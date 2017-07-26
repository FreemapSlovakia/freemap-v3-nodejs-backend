const ebl = require('express-bunyan-logger');

const logger = require('~/logger');

module.exports = ebl({
  logger: logger.child({ module: 'http-server' }),
  parseUA: false,
  genReqId() { },
  excludes: ['user-agent', 'body', 'short-body', 'req-headers', 'res-headers',
    'req', 'res', 'incoming', 'response-hrtime', 'referer', 'url'],
});
