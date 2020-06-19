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
        },
      },
      true,
    ),
    authenticator(true),
    runInTransaction(),
    async (ctx) => {
      const conn = ctx.state.dbConn;

      const id = Number(ctx.params.id);

      const [item] = await conn.query(
        SQL`SELECT userId FROM map WHERE id = ${id} FOR UPDATE`,
      );

      if (!item) {
        ctx.throw(404, 'no such map');
      }

      if (!ctx.state.user.isAdmin && item.userId !== ctx.state.user.id) {
        ctx.throw(403);
      }

      const { name, public: pub, data } = ctx.request.body;

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

      const query = SQL`UPDATE map SET`;

      for (let i = 0; i < parts.length; i++) {
        query.append(i ? ',' : ' ').append(parts[i]);
      }

      await conn.query(query.append(SQL` WHERE id = ${id}`));

      ctx.status = 204;
    },
  );
}
