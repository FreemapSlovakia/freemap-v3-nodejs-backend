import Router from '@koa/router';
import sql from 'sql-template-tag';
import { blockedCreditIds } from 'src/blockedCredits.js';
import { authenticator } from '../authenticator.js';
import { pool, runInTransaction } from '../database.js';
import { bodySchemaValidator } from '../requestValidators.js';

export function attachLoggerHandler(router: Router) {
  router.post(
    '/downloadMap',
    authenticator(true),
    bodySchemaValidator({
      type: 'object',
      required: ['boundingMultipolygon', 'urlTemplate', 'maxZoom'],
      properties: {
        urlTemplate: {
          type: 'string',
        },
        minZoom: {
          type: 'number',
          minimum: 0,
          default: 0,
        },
        maxZoom: {
          type: 'number',
          minimum: 0,
          maximum: 20,
        },
        boundingMultipolygon: {
          type: 'array',
          items: {
            type: 'array',
            items: {
              type: 'array',
              items: [
                {
                  type: 'number',
                  minimum: -180,
                  maximum: 180,
                },
                {
                  type: 'number',
                  minimum: -90,
                  maximum: 90,
                },
              ],
            },
          },
        },
      },
    }),
    runInTransaction(),
    async (ctx) => {
      if (!ctx.state.user?.email) {
        ctx.throw(409, 'absent email address');
        return;
      }

      let [{ credits }] = await pool.query(
        sql`SELECT credits FROM user WHERE id = ${ctx.state.user.id} FOR UPDATE`,
      );

      const price = 100; // TODO compute

      credits -= price;

      // TODO add to reserved amount and subtract if resource is generated

      if (credits < 0) {
        ctx.throw(409, '');
        return;
      }

      pool.query(
        sql`UPDATE user SET credits = ${credits} WHERE id = ${ctx.state.user.id}${ctx.state.user.id}`,
      );

      const { insertId } = await pool.query(
        sql`INSERT INTO blocked_credit SET amount = ${price}, userId = ${ctx.state.user.id}`,
      );

      blockedCreditIds.add(insertId);

      const { urlTemplate, minZoom, maxZoom, boundingMultipolygon } =
        ctx.request.body;

      // download in background

      // send email

      ctx.status = 204;
    },
  );
}
