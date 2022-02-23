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
          writers: {
            type: 'array',
            items: {
              type: 'number',
            },
          },
        },
      },
      true,
    ),
    authenticator(true),
    async (ctx) => {
      const { name, public: pub, data, writers } = ctx.request.body;

      const id = randomize('Aa0', 8);

      const now = new Date();

      await pool.query(SQL`
        INSERT INTO map SET
          id = ${id},
          name = ${name},
          public = ${pub},
          userId = ${ctx.state.user.id},
          data = ${JSON.stringify(data)}
          modifiedAt = ${now},
          modifiedAt = ${now}
      `);

      if (writers?.length) {
        const sql = SQL`INSERT INTO mapWriteAccess (mapId, userId) VALUES `;

        let first = true;

        for (const writer of writers) {
          if (first) {
            first = false;
          } else {
            sql.append(',');
          }

          sql.append(SQL`(${id}, ${writer})`);
        }

        await pool.query(sql);
      }

      ctx.body = {
        id,
        createdNow: now.toISOString(),
        modifiedAt: now.toISOString(),
      };
    },
  );
}
