import Router from '@koa/router';

import { SQL } from 'sql-template-strings';
import randomize from 'randomatic';
import { pool } from '../../database';
import { acceptValidator } from '../../requestValidators';
import { authenticator } from '../../authenticator';
import { bodySchemaValidator } from '../../requestValidators';

export function attachPostTokenHandler(router: Router) {
  router.post(
    '/devices/:id/access-tokens',
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
    async ctx => {
      const [device] = await pool.query(
        SQL`SELECT userId FROM trackingDevice WHERE id = ${ctx.params.id}`,
      );

      if (!device) {
        ctx.throw(404, 'no such tracking device');
      }

      if (!ctx.state.user.isAdmin && ctx.state.user.id !== device.userId) {
        ctx.throw(403);
      }

      const token = randomize('Aa0', 8);
      const { timeFrom, timeTo, note, listingLabel } = ctx.request.body;

      const { insertId } = await pool.query(SQL`
        INSERT INTO trackingAccessToken SET
          deviceId = ${ctx.params.id},
          token = ${token},
          timeFrom = ${timeFrom && new Date(timeFrom)},
          timeTo = ${timeTo && new Date(timeTo)},
          note = ${note},
          listingLabel = ${listingLabel}
      `);

      ctx.body = { id: insertId, token };
    },
  );
}
