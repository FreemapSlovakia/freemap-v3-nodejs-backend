import pino, { stdSerializers } from 'pino';

export const appLogger = pino({
  name: 'freemap-api',
  serializers: stdSerializers,
});
