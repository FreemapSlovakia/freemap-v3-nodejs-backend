import { RouterInstance } from '@koa/router';
import sql from 'sql-template-tag';
import { authenticator } from '../../authenticator.js';
import { pool } from '../../database.js';
import { AUTH_REQUIRED, registerPath } from '../../openapi.js';
import { acceptValidator } from '../../requestValidators.js';
import { TrackingDeviceSchema } from '../../types.js';

const DevicesSchema = TrackingDeviceSchema.array();

export function attachGetAllDevicesHandler(router: RouterInstance) {
  registerPath('/tracking/devices', {
    get: {
      security: AUTH_REQUIRED,
      responses: {
        200: {
          content: {
            'application/json': {
              schema: DevicesSchema,
            },
          },
        },
      },
    },
  });

  router.get(
    '/devices',
    acceptValidator('application/json'),
    authenticator(true),
    async (ctx) => {
      ctx.body = DevicesSchema.parse(
        await pool.query(sql`
          SELECT id, name, token, createdAt, maxCount, maxAge, userId
            FROM trackingDevice
            WHERE userId = ${ctx.state.user!.id}
        `),
      );
    },
  );
}
