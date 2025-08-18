import Router from '@koa/router';

import sql, { bulk, empty } from 'sql-template-tag';
import { assert, tags } from 'typia';
import { authenticator } from '../../authenticator.js';
import { runInTransaction } from '../../database.js';
import { acceptValidator } from '../../requestValidators.js';

export function attachPatchMapHandler(router: Router) {
  router.patch(
    '/:id',
    acceptValidator('application/json'),
    authenticator(true),
    async (ctx) => {
      type Body = {
        name?: string & tags.MinLength<1> & tags.MaxLength<255>;
        data?: Record<string, unknown>;
        public?: boolean;
        writers?: number[];
      };

      let body;

      try {
        body = assert<Body>(ctx.request.body);
      } catch (err) {
        return ctx.throw(400, err as Error);
      }

      const { id } = ctx.params;

      await runInTransaction(async (conn) => {
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
        ).map(({ userId }: { userId: number }) => userId);

        const { name, public: pub, data, writers } = body;

        const user = ctx.state.user!;

        if (
          !user.isAdmin &&
          item.userId !== user.id &&
          (!curWriters.includes(user.id) ||
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
            ${name === undefined ? empty : sql`, name = ${name}`}
            ${pub === undefined ? empty : sql`, public = ${pub}`}
            ${data === undefined ? empty : sql`, data = ${JSON.stringify(data)}`}
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
      });
    },
  );
}
