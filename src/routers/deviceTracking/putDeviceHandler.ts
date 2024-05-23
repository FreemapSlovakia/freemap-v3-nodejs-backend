import Router from '@koa/router';

import sql, { empty } from 'sql-template-tag';
import randomize from 'randomatic';
import { runInTransaction } from '../../database.js';
import { acceptValidator } from '../../requestValidators.js';
import { authenticator } from '../../authenticator.js';
import { bodySchemaValidator } from '../../requestValidators.js';

export function attachPutDeviceHandler(router: Router) {
  router.put(
    '/devices/:id',
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
          regenerateToken: {
            type: ['boolean', 'null'],
          },
        },
      },
      true,
    ),
    authenticator(true),
    runInTransaction(),
    async (ctx) => {
      const { id } = ctx.params;

      const conn = ctx.state.dbConn;

      const [item] = await conn.query(
        sql`SELECT userId FROM trackingDevice WHERE id = ${id} FOR UPDATE`,
      );

      if (!item) {
        ctx.throw(404, 'no such tracking device');
      }

      if (!ctx.state.user.isAdmin && item.userId !== ctx.state.user.id) {
        ctx.throw(403);
      }

      const { name, maxCount, maxAge, regenerateToken } = ctx.request.body;
      let token;

      if (regenerateToken) {
        token = randomize('Aa0', 8);
      }

      await conn.query(
        sql`UPDATE trackingDevice SET name = ${name}, maxCount = ${maxCount}, maxAge = ${maxAge}
          ${regenerateToken ? sql`, token = ${token}` : empty} WHERE id = ${id}`,
      );

      if (maxAge != null) {
        await conn.query(sql`
          DELETE FROM trackingPoint WHERE deviceId = ${id} AND TIMESTAMPDIFF(SECOND, createdAt, now()) > ${maxAge}
        `);
      }

      if (maxCount != null) {
        await conn.query(sql`
        DELETE t FROM trackingPoint AS t
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
