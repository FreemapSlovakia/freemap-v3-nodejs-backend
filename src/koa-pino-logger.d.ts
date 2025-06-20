declare module 'koa-pino-logger' {
  import { Middleware as BaseMiddleware } from 'koa';
  import { DestinationStream, Logger } from 'pino';
  import { Options } from 'pino-http';

  interface Middleware extends BaseMiddleware {
    logger: Logger;
  }

  function koaPinoLogger(
    opts?: Options,
    stream?: DestinationStream,
  ): Middleware;
  function koaPinoLogger(stream?: DestinationStream): Middleware;

  export = koaPinoLogger;
}
