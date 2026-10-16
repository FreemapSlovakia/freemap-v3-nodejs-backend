import type { RouterInstance } from '@koa/router';

import sql from 'sql-template-tag';
import z from 'zod';
import { authenticator } from '../../authenticator.js';
import { isSqlDuplicateError, runInTransaction } from '../../database.js';
import { pruneTrackPoints } from '../../deviceTracking.js';
import { AUTH_REQUIRED, registerPath } from '../../openapi.js';
import { nanoid } from '../../randomId.js';
import { acceptValidator } from '../../requestValidators.js';
import { isOwnerOrRole } from '../../roles.js';
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

      const id = Number(ctx.params.id);

      if (!Number.isSafeInteger(id) || id < 0) {
        return ctx.throw(400, 'invalid id');
      }

      const { name, maxCount, maxAge, token = nanoid() } = body;

      await runInTransaction(async (conn) => {
        const [item] = await conn.query<{ userId: number }[]>(
          sql`SELECT userId FROM trackingDevice WHERE id = ${id} FOR UPDATE`,
        );

        if (!item) {
          ctx.throw(404, 'no such tracking device');
        }

        if (!isOwnerOrRole(ctx.state.user, item.userId, 'trackingManager')) {
          ctx.throw(403);
        }

        try {
          await conn.query<unknown>(
            sql`UPDATE trackingDevice SET name = ${name}, maxCount = ${maxCount}, maxAge = ${maxAge}, token = ${token} WHERE id = ${id}`,
          );
        } catch (err) {
          if (isSqlDuplicateError(err)) {
            ctx.throw(409);
          }

          throw err;
        }

        await pruneTrackPoints(conn, id, maxAge, maxCount);
      });

      ctx.body = { token };
    },
  );
}
