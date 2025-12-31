import { RouterInstance } from '@koa/router';
import { assert } from 'typia';

const levelsAsConst = [
  'trace',
  'debug',
  'info',
  'warn',
  'error',
  'fatal',
] as const;

const levels: string[] = levelsAsConst.map((level) => level);

type LogLevelString = (typeof levelsAsConst)[number];

export type Body = {
  level: LogLevelString;
  message: string;
  details?: Record<string, unknown>;
};

export function attachLoggerHandler(router: RouterInstance) {
  router.post('/logger', async (ctx) => {
    let body;

    try {
      body = assert<Body>(ctx.request.body);
    } catch (err) {
      return ctx.throw(400, err as Error);
    }

    const { level, message, details = {} } = body;

    ctx.log[validateLevel(level)](
      Object.assign({ subModule: 'client' }, details),
      message,
    );

    ctx.body = { id: ctx.reqId };
  });
}

function validateLevel(level: string): LogLevelString {
  if (levels.includes(level)) {
    return level as LogLevelString;
  }

  throw new Error('invalid loglevel');
}
