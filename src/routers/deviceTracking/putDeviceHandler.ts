import { RouterInstance } from '@koa/router';

import sql from 'sql-template-tag';
import z from 'zod';
import { authenticator } from '../../authenticator.js';
import { isSqlDuplicateError, runInTransaction } from '../../database.js';
import { AUTH_REQUIRED, registerPath } from '../../openapi.js';
import { nanoid } from '../../randomId.js';
import { acceptValidator } from '../../requestValidators.js';
import { DeviceBodySchema } from '../../types.js';

const ResponseBodySchema = z.strictObject({ token: z.string() });

export function attachPutDeviceHandler(router: RouterInstance) {
  registerPath('/tracking/devices/{id}', {
    put: {
      summary: 'Update a tracking device',
      tags: ['tracking'],
      security: AUTH_REQUIRED,
      requestParams: {
        path: z.object({
          id: z.uint32(),
        }),
      },
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
        403: {},
        404: { description: 'no such tracking device' },
        409: {},
      },
    },
  });

  router.put(
    '/devices/:id',
    acceptValidator('application/json'),
    authenticator(true),
    async (ctx) => {
      let body;

      try {
        body = DeviceBodySchema.parse(ctx.request.body);
      } catch (err) {
        return ctx.throw(400, err as Error);
      }

      const { id } = ctx.params;

      const { name, maxCount, maxAge, token = nanoid() } = body;

      await runInTransaction(async (conn) => {
        const [item] = await conn.query(
          sql`SELECT userId FROM trackingDevice WHERE id = ${id} FOR UPDATE`,
        );

        if (!item) {
          ctx.throw(404, 'no such tracking device');
        }

        if (!ctx.state.user!.isAdmin && item.userId !== ctx.state.user!.id) {
          ctx.throw(403);
        }

        try {
          await conn.query(
            sql`UPDATE trackingDevice SET name = ${name}, maxCount = ${maxCount}, maxAge = ${maxAge}, token = ${token} WHERE id = ${id}`,
          );
        } catch (err) {
          if (isSqlDuplicateError(err)) {
            ctx.throw(409);
          }

          throw err;
        }

        if (maxAge != null) {
          await conn.query(sql`
            DELETE FROM trackingPoint WHERE deviceId = ${id} AND TIMESTAMPDIFF(SECOND, createdAt, NOW()) > ${maxAge}
          `);
        }

        if (maxCount != null) {
          await conn.query(sql`
            DELETE t
            FROM trackingPoint AS t
            JOIN (
              SELECT id FROM trackingPoint WHERE deviceId = ${id}
                ORDER BY id DESC LIMIT 18446744073709551615 OFFSET ${maxCount}
            ) tlimit ON t.id = tlimit.id
        `);
        }
      });

      ctx.body = { token };
    },
  );
}
