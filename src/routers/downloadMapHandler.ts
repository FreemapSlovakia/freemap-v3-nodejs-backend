import Router from '@koa/router';
import sql from 'sql-template-tag';
import { authenticator } from '../authenticator.js';
import { pool } from '../database.js';
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
    async (ctx) => {
      if (!ctx.state.user?.email) {
        ctx.throw(403, 'absent email address');
        return;
      }

      const [spent, credits];
      pool.query(
        sql`SELECT SUM(amount) FROM spending WHERE userId = ${ctx.state.user.id}`,
      );

      pool.query(
        sql`SELECT SUM(credits) FROM purchase WHERE userId = ${ctx.state.user.id}`,
      );

      const { urlTemplate, minZoom, maxZoom, boundingMultipolygon } =
        ctx.request.body;

      ctx.status = 204;
    },
  );
}
