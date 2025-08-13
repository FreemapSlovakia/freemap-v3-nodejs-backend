import Router from '@koa/router';

import sql, { bulk } from 'sql-template-tag';
import { assert, tags } from 'typia';
import { authenticator } from '../../authenticator.js';
import { pool } from '../../database.js';
import { nanoid } from '../../randomId.js';
import { acceptValidator } from '../../requestValidators.js';

export function attachPostMapHandler(router: Router) {
  router.post(
    '/',
    acceptValidator('application/json'),
    authenticator(true),
    async (ctx) => {
      type Body = {
        name: string & tags.MinLength<1> & tags.MaxLength<255>;
        data?: Record<string, unknown>;
        public?: boolean;
        writers?: (number & tags.Type<'uint32'>)[];
      };

      let body;

      try {
        body = assert<Body>(ctx.request.body);
      } catch (err) {
        return ctx.throw(400, err as Error);
      }

      const { name, public: pub, data, writers } = body;

      const id = nanoid();

      const now = new Date();

      const userId = ctx.state.user!.id;

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
          sql`INSERT INTO mapWriteAccess (mapId, userId) VALUES ${bulk(writers.map((writer) => [id, writer]))}`,
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
