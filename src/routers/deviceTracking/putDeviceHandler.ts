import Router from '@koa/router';

import sql, { empty } from 'sql-template-tag';
import { assert, tags } from 'typia';
import { authenticator } from '../../authenticator.js';
import { runInTransaction } from '../../database.js';
import { nanoid } from '../../randomId.js';
import { acceptValidator } from '../../requestValidators.js';

export type Body = {
  name: string & tags.MinLength<1> & tags.MaxLength<255>;
  maxCount?: (number & tags.Type<'uint32'>) | null;
  maxAge?: (number & tags.Type<'uint32'>) | null;
  regenerateToken?: boolean | null;
};

export function attachPutDeviceHandler(router: Router) {
  router.put(
    '/devices/:id',
    acceptValidator('application/json'),
    authenticator(true),
    runInTransaction(),
    async (ctx) => {
      let body;

      try {
        body = assert<Body>(ctx.request.body);
      } catch (err) {
        return ctx.throw(400, err as Error);
      }

      const { id } = ctx.params;

      const conn = ctx.state.dbConn!;

      const [item] = await conn.query(
        sql`SELECT userId FROM trackingDevice WHERE id = ${id} FOR UPDATE`,
      );

      if (!item) {
        ctx.throw(404, 'no such tracking device');
      }

      if (!ctx.state.user!.isAdmin && item.userId !== ctx.state.user!.id) {
        ctx.throw(403);
      }

      const { name, maxCount, maxAge, regenerateToken } = body;

      let token;

      if (regenerateToken) {
        token = nanoid();
      }

      await conn.query(
        sql`UPDATE trackingDevice SET name = ${name}, maxCount = ${maxCount}, maxAge = ${maxAge}
          ${regenerateToken ? sql`, token = ${token}` : empty} WHERE id = ${id}`,
      );

      if (maxAge != null) {
        await conn.query(sql`
          DELETE FROM trackingPoint WHERE deviceId = ${id} AND TIMESTAMPDIFF(SECOND, createdAt, NOW()) > ${maxAge}
        `);
      }

      if (maxCount != null) {
        await conn.query(sql`
          DELETE t
          FROM trackingPoint AS t
          JOIN (
            SELECT id FROM trackingPoint WHERE deviceId = ${id}
              ORDER BY id DESC LIMIT 18446744073709551615 OFFSET ${maxCount}
          ) tlimit ON t.id = tlimit.id
      `);
      }

      ctx.body = { token };
    },
  );
}
