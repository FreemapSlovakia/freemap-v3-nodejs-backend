import Router from '@koa/router';

import { SQL } from 'sql-template-strings';
import { pool } from '../../database';
import { acceptValidator } from '../../requestValidators';
import { authenticator } from '../../authenticator';
import { bodySchemaValidator } from '../../requestValidators';
import randomize from 'randomatic';

export function attachPostMapHandler(router: Router) {
  router.post(
    '/',
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
          data: {
            type: 'object',
          },
          public: {
            type: 'boolean',
          },
        },
      },
      true,
    ),
    authenticator(true),
    async (ctx) => {
      const { name, public: pub, data } = ctx.request.body;

      const id = randomize('Aa0', 8);

      await pool.query(SQL`
        INSERT INTO map SET
          id = ${id},
          name = ${name},
          public = ${pub},
          userId = ${ctx.state.user.id},
          data = ${JSON.stringify(data)}
      `);

      ctx.body = { id };
    },
  );
}
