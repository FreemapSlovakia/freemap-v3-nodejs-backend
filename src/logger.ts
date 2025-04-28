import { pino } from 'pino';

export const appLogger = pino({
  name: 'freemap-api',
  serializers: pino.stdSerializers,
});
