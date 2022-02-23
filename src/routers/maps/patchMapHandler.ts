import Router from '@koa/router';

import { SQL } from 'sql-template-strings';
import { runInTransaction } from '../../database';
import { acceptValidator } from '../../requestValidators';
import { authenticator } from '../../authenticator';
import { bodySchemaValidator } from '../../requestValidators';

export function attachPatchMapHandler(router: Router) {
  router.patch(
    '/:id',
    acceptValidator('application/json'),
    bodySchemaValidator(
      {
        type: 'object',
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
    runInTransaction(),
    async (ctx) => {
      const conn = ctx.state.dbConn;

      const { id } = ctx.params;

      const [item] = await conn.query(
        SQL`SELECT userId, modifiedAt FROM map WHERE id = ${id} FOR UPDATE`,
      );

      if (!item) {
        ctx.throw(404, 'no such map');
      }

      const curWriters = (
        await conn.query(
          SQL`SELECT userId FROM mapWriteAccess WHERE mapId = ${id} FOR UPDATE`,
        )
      ).map(({ userId }: any) => userId);

      const { name, public: pub, data, writers } = ctx.request.body;

      if (
        !ctx.state.user.isAdmin &&
        item.userId !== ctx.state.user.id &&
        (!curWriters.includes(ctx.state.user.id) ||
          writers !== undefined ||
          pub !== undefined ||
          name !== undefined)
      ) {
        ctx.throw(403);
      }

      if (
        ctx.request.headers['if-unmodified-since'] &&
        new Date(ctx.request.headers['if-unmodified-since']).getTime() <
          item.modifiedAt.getTime()
      ) {
        ctx.throw(412);
      }

      const parts = [];

      if (name !== undefined) {
        parts.push(SQL`name = ${name}`);
      }

      if (pub !== undefined) {
        parts.push(SQL`public = ${pub}`);
      }

      if (data !== undefined) {
        parts.push(SQL`data = ${JSON.stringify(data)}`);
      }

      const now = new Date();

      const query = SQL`UPDATE map SET modifiedAt = ${now}`;

      for (let i = 0; i < parts.length; i++) {
        query.append(',').append(parts[i]);
      }

      await conn.query(query.append(SQL` WHERE id = ${id}`));

      if (writers) {
        conn.query(SQL`DELETE FROM mapWriteAccess WHERE mapId = ${id}`);

        if (writers.length) {
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

          await conn.query(sql);
        }
      }

      ctx.body = {
        id,
        modifiedAt: now.toISOString(),
      };
    },
  );
}
