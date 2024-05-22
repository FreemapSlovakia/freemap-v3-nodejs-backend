import Router from '@koa/router';

import sql, { bulk, empty, join } from 'sql-template-tag';
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
        sql`SELECT userId, name, createdAt, modifiedAt, public FROM map WHERE id = ${id} FOR UPDATE`,
      );

      if (!item) {
        ctx.throw(404, 'no such map');
      }

      const curWriters = (
        await conn.query(
          sql`SELECT userId FROM mapWriteAccess WHERE mapId = ${id} FOR UPDATE`,
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

      const now = new Date();

      await conn.query(sql`UPDATE map SET modifiedAt = ${now}
        ${name === undefined ? empty : sql`name = ${name}`}
        ${pub === undefined ? empty : sql`public = ${pub}`}
        ${data === undefined ? empty : sql`data = ${JSON.stringify(data)}`}
        WHERE id = ${id}
      `);

      if (writers) {
        conn.query(sql`DELETE FROM mapWriteAccess WHERE mapId = ${id}`);

        if (writers.length) {
          await conn.query(
            sql`INSERT INTO mapWriteAccess (mapId, userId) VALUES ${bulk(writers.map((writer: number) => [id, writer]))}`,
          );
        }
      }

      ctx.body = {
        id,
        createdAt: item.createdAt.toISOString(),
        modifiedAt: now.toISOString(),
        public: pub ?? item.public,
        writers: writers ?? curWriters,
        name: name ?? item.name,
        userId: item.userId,
        canWrite: true,
      };
    },
  );
}
