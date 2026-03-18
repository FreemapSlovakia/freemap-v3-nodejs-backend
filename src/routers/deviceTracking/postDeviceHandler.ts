import { RouterInstance } from '@koa/router';
import sql from 'sql-template-tag';
import z from 'zod';
import { authenticator } from '../../authenticator.js';
import { isSqlDuplicateError, pool } from '../../database.js';
import { AUTH_REQUIRED, registerPath } from '../../openapi.js';
import { nanoid } from '../../randomId.js';
import { acceptValidator } from '../../requestValidators.js';
import { DeviceBodySchema } from '../../types.js';

const ResponseBodySchema = z.strictObject({
  id: z.uint32(),
  token: z.string().nonempty(),
});

export function attachPostDeviceHandler(router: RouterInstance) {
  registerPath('/tracking/devices', {
    post: {
      summary: 'Create a new tracking device',
      tags: ['tracking'],
      security: AUTH_REQUIRED,
      requestBody: {
        content: {
          'application/json': {
            schema: DeviceBodySchema,
          },
        },
      },
      responses: {
        200: {
          content: { 'application/json': { schema: ResponseBodySchema } },
        },
        409: {},
      },
    },
  });

  router.post(
    '/devices',
    acceptValidator('application/json'),
    authenticator(true),
    async (ctx) => {
      let body;

      try {
        body = DeviceBodySchema.parse(ctx.request.body);
      } catch (err) {
        return ctx.throw(400, err as Error);
      }

      const { name, maxCount, maxAge, token = '' } = body;

      const okToken = token || nanoid();

      try {
        const { insertId } = await pool.query(sql`
          INSERT INTO trackingDevice SET
            name = ${name},
            token = ${okToken},
            userId = ${ctx.state.user!.id},
            maxCount = ${maxCount},
            maxAge = ${maxAge}
        `);

        ctx.body = ResponseBodySchema.parse({ id: insertId, token: okToken });
      } catch (err) {
        if (isSqlDuplicateError(err)) {
          ctx.throw(409);
        }

        throw err;
      }
    },
  );
}
