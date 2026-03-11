import { RouterInstance } from '@koa/router';
import sql from 'sql-template-tag';
import { authenticator } from '../../authenticator.js';
import { pool } from '../../database.js';
import { AUTH_REQUIRED, registerPath } from '../../openapi.js';
import { acceptValidator } from '../../requestValidators.js';
import { TrackingDeviceSchema } from '../../types.js';

export function attachGetDeviceHandler(router: RouterInstance) {
  registerPath('/tracking/devices/{id}', {
    get: {
      summary: 'Get a tracking device by ID',
      tags: ['tracking'],
      security: AUTH_REQUIRED,
      parameters: [
        {
          in: 'path',
          name: 'id',
          required: true,
          schema: { type: 'integer' },
        },
      ],
      responses: {
        200: {
          content: {
            'application/json': {
              schema: TrackingDeviceSchema,
            },
          },
        },
        403: {},
        404: { description: 'no such tracking device' },
      },
    },
  });

  router.get(
    '/devices/:id',
    acceptValidator('application/json'),
    authenticator(true),
    async (ctx) => {
      const [item] = TrackingDeviceSchema.array()
        .max(1)
        .parse(
          await pool.query(sql`
            SELECT id, name, token, createdAt, maxCount, maxAge, userId
              FROM trackingDevice
              WHERE id = ${ctx.params.id}
          `),
        );

      if (!item) {
        ctx.throw(404, 'no such tracking device');
      }

      if (!ctx.state.user?.isAdmin && ctx.state.user?.id !== item.userId) {
        ctx.throw(403);
      }

      ctx.body = item;
    },
  );
}
