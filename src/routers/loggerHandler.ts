import Router from '@koa/router';

import { bodySchemaValidator } from '../requestValidators';

export default function attachCreateTracklogHandler(router: Router) {
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
      ctx.log[level](Object.assign({ subModule: 'client' }, details), message);

      ctx.body = { id: ctx.reqId };
    },
  );
}
