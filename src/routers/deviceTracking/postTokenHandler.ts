import { RouterInstance } from '@koa/router';

import sql from 'sql-template-tag';
import { assert, type tags } from 'typia';
import { authenticator } from '../../authenticator.js';
import { pool } from '../../database.js';
import { nanoid } from '../../randomId.js';
import { acceptValidator } from '../../requestValidators.js';

export function attachPostTokenHandler(router: RouterInstance) {
  router.post(
    '/devices/:id/access-tokens',
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

      const [device] = await pool.query(
        sql`SELECT userId FROM trackingDevice WHERE id = ${ctx.params.id}`,
      );

      if (!device) {
        ctx.throw(404, 'no such tracking device');
      }

      if (!ctx.state.user!.isAdmin && ctx.state.user!.id !== device.userId) {
        ctx.throw(403);
      }

      const token = nanoid();

      const { timeFrom, timeTo, note, listingLabel } = body;

      const { insertId } = await pool.query(sql`
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
