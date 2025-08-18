import Router from '@koa/router';
import sql from 'sql-template-tag';
import { assert, tags } from 'typia';
import { authenticator } from '../../authenticator.js';
import { runInTransaction } from '../../database.js';
import { acceptValidator } from '../../requestValidators.js';

export function attachPutTokenHandler(router: Router) {
  router.put(
    '/access-tokens/:id',
    acceptValidator('application/json'),
    authenticator(true),
    async (ctx) => {
      type Body = {
        timeFrom?: (string & tags.Format<'date-time'>) | null;
        timeTo?: (string & tags.Format<'date-time'>) | null;
        note?: (string & tags.MaxLength<255>) | null;
        listingLabel?: (string & tags.MaxLength<255>) | null;
      };

      let body;

      try {
        body = assert<Body>(ctx.request.body);
      } catch (err) {
        return ctx.throw(400, err as Error);
      }

      await runInTransaction(async (conn) => {
        const [item] = await conn.query(sql`
          SELECT userId
            FROM trackingAccessToken
            JOIN trackingDevice ON (deviceId = trackingDevice.id)
            WHERE trackingAccessToken.id = ${ctx.params.id}
            FOR UPDATE
        `);

        if (!item) {
          ctx.throw(404, 'no such tracking access token');
        }

        if (!ctx.state.user!.isAdmin && item.userId !== ctx.state.user!.id) {
          ctx.throw(403);
        }

        const { timeFrom, timeTo, note, listingLabel } = body;

        await conn.query(sql`
            UPDATE trackingAccessToken SET
              note = ${note},
              timeFrom = ${timeFrom && new Date(timeFrom)},
              timeTo = ${timeTo && new Date(timeTo)},
              listingLabel = ${listingLabel}
              WHERE id = ${ctx.params.id}
          `);
      });

      ctx.status = 204;
    },
  );
}
