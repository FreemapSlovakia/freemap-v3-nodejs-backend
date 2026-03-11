import { RouterInstance } from '@koa/router';

import sql from 'sql-template-tag';
import z from 'zod';
import { authenticator } from '../../authenticator.js';
import { pool } from '../../database.js';
import { AUTH_REQUIRED, registerPath } from '../../openapi.js';
import { nanoid } from '../../randomId.js';
import { acceptValidator } from '../../requestValidators.js';
import { TokenBodySchema } from '../../types.js';

const ResponseBodySchema = z.strictObject({
  id: z.uint32(),
  token: z.string(),
});

export function attachPostTokenHandler(router: RouterInstance) {
  registerPath('/tracking/devices/{id}/access-tokens', {
    post: {
      summary: 'Create an access token for a tracking device',
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
      requestBody: {
        content: {
          'application/json': {
            schema: TokenBodySchema,
          },
        },
      },
      responses: {
        200: {
          content: { 'application/json': { schema: ResponseBodySchema } },
        },
        403: {},
        404: { description: 'no such tracking device' },
      },
    },
  });

  router.post(
    '/devices/:id/access-tokens',
    acceptValidator('application/json'),
    authenticator(true),
    async (ctx) => {
      let body;

      try {
        body = TokenBodySchema.parse(ctx.request.body);
      } catch (err) {
        return ctx.throw(400, err as Error);
      }

      const [device] = z
        .strictObject({ userId: z.uint32() })
        .array()
        .max(1)
        .parse(
          await pool.query(
            sql`SELECT userId FROM trackingDevice WHERE id = ${ctx.params.id}`,
          ),
        );

      if (!device) {
        ctx.throw(404, 'no such tracking device');
      }

      if (!ctx.state.user!.isAdmin && ctx.state.user!.id !== device.userId) {
        ctx.throw(403);
      }

      const token = nanoid();

      const { timeFrom, timeTo, note, listingLabel } = body;

      const { insertId } = await pool.query(sql`
        INSERT INTO trackingAccessToken SET
          deviceId = ${ctx.params.id},
          token = ${token},
          timeFrom = ${timeFrom && new Date(timeFrom)},
          timeTo = ${timeTo && new Date(timeTo)},
          note = ${note},
          listingLabel = ${listingLabel}
      `);

      ctx.body = ResponseBodySchema.parse({ id: insertId, token });
    },
  );
}
