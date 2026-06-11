import * as Sentry from '@sentry/node';
import { getEnv } from './env.js';

const dsn = getEnv('SENTRY_DSN', '');

if (dsn) {
  Sentry.init({
    dsn,
    environment: getEnv(
      'SENTRY_ENVIRONMENT',
      getEnv('NODE_ENV', 'development'),
    ),
    // Attach request IP / user / headers to events. Safe-ish here because the
    // Sentry instance is self-hosted; Sentry's default data scrubber still
    // redacts the Authorization header and token-like fields.
    sendDefaultPii: true,
    // 0 = errors only; raise to sample performance traces.
    tracesSampleRate: Number(getEnv('SENTRY_TRACES_SAMPLE_RATE', '0')),
    // Don't report expected client errors (4xx) thrown via ctx.throw().
    beforeSend(event, hint) {
      const status =
        (hint?.originalException as { status?: number; statusCode?: number })
          ?.status ??
        (hint?.originalException as { status?: number; statusCode?: number })
          ?.statusCode;

      if (typeof status === 'number' && status >= 400 && status < 500) {
        return null;
      }

      return event;
    },
  });
}

export { Sentry };
