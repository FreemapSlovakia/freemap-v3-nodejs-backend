import { RouterInstance } from '@koa/router';
import z from 'zod';
import { registerPath } from '../openapi.js';

const BodySchema = z.strictObject({
  level: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']),
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
});

const ResponseSchema = z.strictObject({ id: z.string() });

export function attachLoggerHandler(router: RouterInstance) {
  registerPath('/logger', {
    post: {
      summary: 'Submit a client-side log entry',
      tags: ['misc'],
      requestBody: {
        content: { 'application/json': { schema: BodySchema } },
      },
      responses: {
        200: { content: { 'application/json': { schema: ResponseSchema } } },
      },
    },
  });

  router.post('/logger', async (ctx) => {
    let body;

    try {
      body = BodySchema.parse(ctx.request.body);
    } catch (err) {
      return ctx.throw(400, err as Error);
    }

    const { level, message, details = {} } = body;

    ctx.log[level](Object.assign({ subModule: 'client' }, details), message);

    ctx.body = ResponseSchema.parse({ id: ctx.reqId });
  });
}
