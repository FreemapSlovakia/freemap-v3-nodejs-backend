import Router from '@koa/router';

import { bodySchemaValidator } from '../requestValidators.js';

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

export function attachLoggerHandler(router: Router) {
  router.post(
    '/logger',
    bodySchemaValidator({
      type: 'object',
      required: ['level', 'message'],
      properties: {
        level: {
          type: 'string',
          enum: levels,
        },
        message: {
          type: 'string',
        },
        details: {
          type: 'object',
        },
      },
    }),
    async (ctx) => {
      const { level, message, details = {} } = ctx.request.body;
      ctx.log[validateLevel(level)](
        Object.assign({ subModule: 'client' }, details),
        message,
      );

      ctx.body = { id: ctx.reqId };
    },
  );
}

function validateLevel(level: string): LogLevelString {
  if (levels.includes(level)) {
    return level as LogLevelString;
  }

  throw new Error('invalid loglevel');
}
