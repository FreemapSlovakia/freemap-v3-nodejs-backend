const bunyan = require('bunyan');

export default bunyan.createLogger({
  name: 'freemap-api',
  serializers: bunyan.stdSerializers,
});
