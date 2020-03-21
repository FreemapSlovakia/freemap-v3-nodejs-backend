import Router from '@koa/router';
import { SQL } from 'sql-template-strings';
import randomize from 'randomatic';
import { pool } from '../../database';
import { acceptValidator } from '../../requestValidators';
import { authenticator } from '../../authenticator';
import { bodySchemaValidator } from '../../requestValidators';
import { JSONSchema7 } from 'json-schema';

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
    async ctx => {
      const token1 = /^(imei|did:).*/.test(ctx.request.body.token ?? '')
        ? ctx.request.body.token
        : randomize('Aa0', 8);

      const { name, maxCount, maxAge } = ctx.request.body;

      const { insertId } = await pool.query(SQL`
        INSERT INTO trackingDevice SET
          name = ${name},
          token = ${token1},
          userId = ${ctx.state.user.id},
          maxCount = ${maxCount},
          maxAge = ${maxAge}
      `);

      ctx.body = { id: insertId, token: token1 };
    },
  );
}
