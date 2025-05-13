import Router from '@koa/router';
import randomize from 'randomatic';
import sql from 'sql-template-tag';
import { authenticator } from '../../authenticator.js';
import { pool } from '../../database.js';
import {
  acceptValidator,
  bodySchemaValidator,
} from '../../requestValidators.js';

export function attachPostDeviceHandler(router: Router) {
  router.post(
    '/devices',
    acceptValidator('application/json'),
    bodySchemaValidator(
      {
        type: 'object',
        required: ['name'],
        properties: {
          name: {
            type: 'string',
            minLength: 1,
            maxLength: 255,
          },
          maxCount: {
            type: ['number', 'null'],
            minimum: 0,
          },
          maxAge: {
            type: ['number', 'null'],
            minimum: 0,
          },
        },
      },
      true,
    ),
    authenticator(true),
    async (ctx) => {
      const token1 = /^(imei|did:).*/.test(ctx.request.body.token ?? '')
        ? ctx.request.body.token
        : randomize('Aa0', 8);

      const { name, maxCount, maxAge } = ctx.request.body;

      const { insertId } = await pool.query(sql`
        INSERT INTO trackingDevice SET
          name = ${name},
          token = ${token1},
          userId = ${ctx.state.user!.id},
          maxCount = ${maxCount},
          maxAge = ${maxAge}
      `);

      ctx.body = { id: insertId, token: token1 };
    },
  );
}
