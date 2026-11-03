import type { RouterInstance } from '@koa/router';
import sql, { raw } from 'sql-template-tag';
import { APP_TOKEN_COLUMNS_SQL, AppTokenSchema } from '../../appTokens.js';
import { authenticator } from '../../authenticator.js';
import { pool } from '../../database.js';
import { AUTH_REQUIRED, registerPath } from '../../openapi.js';
import { acceptValidator } from '../../requestValidators.js';

const ResponseSchema = AppTokenSchema.array();

export function attachGetAppTokensHandler(router: RouterInstance) {
  registerPath('/auth/app-tokens', {
    get: {
      summary: "List the user's app tokens",
      tags: ['auth'],
      security: AUTH_REQUIRED,
      responses: {
        200: {
          content: { 'application/json': { schema: ResponseSchema } },
        },
        401: {},
      },
    },
  });

  router.get(
    '/app-tokens',
    acceptValidator('application/json'),
    authenticator(true),
    async (ctx) => {
      ctx.body = ResponseSchema.parse(
        await pool.query<unknown>(
          sql`SELECT ${raw(APP_TOKEN_COLUMNS_SQL)} FROM appToken
              WHERE userId = ${ctx.state.user!.id}
              ORDER BY createdAt DESC`,
        ),
      );
    },
  );
}
