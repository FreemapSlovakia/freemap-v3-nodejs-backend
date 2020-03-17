import Router from '@koa/router';

import { bodySchemaValidator } from '../requestValidators';

export function attachLoggerHandler(router: Router) {
  router.post(
    '/logger',
    bodySchemaValidator({
      type: 'object',
      required: ['level', 'message'],
      properties: {
        level: {
          type: 'string',
          enum: ['trace', 'debug', 'info', 'warn', 'error', 'fatal'],
        },
        message: {
          type: 'string',
        },
        details: {
          type: 'object',
        },
      },
    }),
    async ctx => {
      const { level, message, details = {} } = ctx.request.body;
      ctx.log[validateLevel(level)](
        Object.assign({ subModule: 'client' }, details),
        message,
      );

      ctx.body = { id: ctx.reqId };
    },
  );
}

const levels = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;

type LogLevelString = typeof levels[number];

function validateLevel(level: string): LogLevelString {
  if (!['trace', 'debug', 'info', 'warn', 'error', 'fatal'].includes(level)) {
    throw new Error('invalid loglevel');
  }

  return level as LogLevelString;
}
