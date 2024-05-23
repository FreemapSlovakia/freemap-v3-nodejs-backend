import Router from '@koa/router';

import sql, { bulk } from 'sql-template-tag';
import { pool } from '../../database.js';
import { acceptValidator } from '../../requestValidators.js';
import { authenticator } from '../../authenticator.js';
import { bodySchemaValidator } from '../../requestValidators.js';
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

      const userId = ctx.state.user.id;

      await pool.query(sql`
        INSERT INTO map SET
          id = ${id},
          name = ${name},
          public = ${pub},
          userId = ${userId},
          createdAt = ${now},
          modifiedAt = ${now},
          data = ${JSON.stringify(data)}
      `);

      if (writers?.length) {
        await pool.query(
          sql`INSERT INTO mapWriteAccess (mapId, userId) VALUES ${bulk(writers.map((writer: number) => [id, writer]))}`,
        );
      }

      ctx.body = {
        id,
        createdAt: now.toISOString(),
        modifiedAt: now.toISOString(),
        public: !!pub,
        writers,
        name,
        userId,
        canWrite: true,
      };
    },
  );
}
