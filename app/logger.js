const bunyan = require('bunyan');

module.exports = bunyan.createLogger({
  name: 'freemap-api',
  serializers: bunyan.stdSerializers
});
