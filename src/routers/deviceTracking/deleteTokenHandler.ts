import Router from '@koa/router';
import SQL from 'sql-template-strings';
import { runInTransaction } from '../../database';
import { acceptValidator } from '../../requestValidators';
import authenticator from '../../authenticator';

export default (router: Router) => {
  router.delete(
    '/access-tokens/:id',
    acceptValidator('application/json'),
    authenticator(true),
    runInTransaction(),
    async ctx => {
      const conn = ctx.state.dbConn;

      const [item] = await conn.query(SQL`
        SELECT userId FROM trackingAccessToken
          JOIN trackingDevice ON (deviceId = trackingDevice.id)
          WHERE trackingAccessToken.id = ${ctx.params.id} FOR UPDATE
      `);

      if (!item) {
        ctx.throw(404);
      }

      if (!ctx.state.user.isAdmin && item.userId !== ctx.state.user.id) {
        ctx.throw(403);
      }

      await conn.query(
        SQL`DELETE FROM trackingAccessToken WHERE id = ${ctx.params.id}`,
      );

      ctx.status = 204;
    },
  );
};
