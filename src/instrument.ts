import * as Sentry from '@sentry/node';
import { isClientError } from './clientError.js';
import { getEnv } from './env.js';

const dsn = getEnv('SENTRY_DSN', '');

if (dsn) {
  Sentry.init({
    dsn,
    environment: getEnv(
      'SENTRY_ENVIRONMENT',
      getEnv('NODE_ENV', 'development'),
    ),
    // 0 = errors only; raise to sample performance traces.
    tracesSampleRate: Number(getEnv('SENTRY_TRACES_SAMPLE_RATE', '0')),
    // Don't report expected client errors (4xx) thrown via ctx.throw().
    beforeSend(event, hint) {
      // A client that hung up mid-response, reported by Koa's body pipeline
      // (Koa sets headerSent on errors raised after the response started).
      const ex = hint?.originalException as
        | { code?: string; headerSent?: boolean }
        | undefined;

      if (ex?.code === 'ERR_STREAM_PREMATURE_CLOSE' && ex.headerSent) {
        return null;
      }

      if (isClientError(hint?.originalException)) {
        return null;
      }

      return event;
    },
  });
}

export { Sentry };
