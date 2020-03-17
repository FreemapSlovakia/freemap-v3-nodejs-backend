import Router from '@koa/router';
import { SQL } from 'sql-template-strings';
import { runInTransaction } from '../../database';
import { acceptValidator } from '../../requestValidators';
import { authenticator } from '../../authenticator';
import { bodySchemaValidator } from '../../requestValidators';

export function attachPutTokenHandler(router: Router) {
  router.put(
    '/access-tokens/:id',
    acceptValidator('application/json'),
    bodySchemaValidator(
      {
        type: 'object',
        properties: {
          timeFrom: {
            type: ['string', 'null'],
            format: 'date-time',
          },
          timeTo: {
            type: ['string', 'null'],
            format: 'date-time',
          },
          note: {
            type: ['string', 'null'],
            maxLength: 255,
          },
          listingLabel: {
            type: ['string', 'null'],
            maxLength: 255,
          },
        },
      },
      true,
    ),
    authenticator(true),
    runInTransaction(),
    async ctx => {
      const conn = ctx.state.dbConn;

      const [item] = await conn.query(SQL`
          SELECT userId
            FROM trackingAccessToken
            JOIN trackingDevice ON (deviceId = trackingDevice.id)
            WHERE trackingAccessToken.id = ${ctx.params.id}
            FOR UPDATE
        `);

      if (!item) {
        ctx.throw(404, 'no such tracking access token');
      }

      if (!ctx.state.user.isAdmin && item.userId !== ctx.state.user.id) {
        ctx.throw(403);
      }

      const { timeFrom, timeTo, note, listingLabel } = ctx.request.body;

      await conn.query(SQL`
            UPDATE trackingAccessToken SET
              note = ${note},
              timeFrom = ${timeFrom && new Date(timeFrom)},
              timeTo = ${timeTo && new Date(timeTo)},
              listingLabel = ${listingLabel}
              WHERE id = ${ctx.params.id}
          `);

      ctx.status = 204;
    },
  );
}
