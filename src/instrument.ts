import * as Sentry from '@sentry/node';
import { isClientError, isHangUp } from './clientError.js';
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
      // A client that hung up mid-response: Koa sets headerSent once the
      // response has started or can no longer be written; see isHangUp.
      const ex = hint?.originalException as
        | { headerSent?: boolean }
        | undefined;

      if (ex?.headerSent && isHangUp(ex)) {
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
