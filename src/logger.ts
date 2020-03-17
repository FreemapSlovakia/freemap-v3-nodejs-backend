import bunyan from 'bunyan';

export const appLogger = bunyan.createLogger({
  name: 'freemap-api',
  serializers: bunyan.stdSerializers,
});
