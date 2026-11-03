import type { RouterInstance } from '@koa/router';
import sql, { raw } from 'sql-template-tag';
import z from 'zod';
import {
  APP_TOKEN_COLUMNS_SQL,
  AppTokenSchema,
  AppTokenScopeSchema,
  generateAppToken,
  hashAppToken,
  isValidExpiresAt,
} from '../../appTokens.js';
import { authenticator } from '../../authenticator.js';
import { runInTransaction } from '../../database.js';
import { AUTH_REQUIRED, registerPath } from '../../openapi.js';
import { acceptValidator } from '../../requestValidators.js';

const BodySchema = z
  .strictObject({
    note: z.string().max(255).nullish(),
    scopes: z.array(AppTokenScopeSchema).min(1),
    expiresAt: z.iso
      .datetime()
      .nullish()
      .meta({ description: 'Omit or null for a token that never expires' }),
  })
  .meta({ id: 'AppTokenBody' });

const ResponseSchema = z
  .strictObject({
    ...AppTokenSchema.shape,
    token: z
      .string()
      .nonempty()
      .meta({ description: 'Returned only here; it is not stored' }),
  })
  .meta({ id: 'CreatedAppToken' });

export function attachPostAppTokenHandler(router: RouterInstance) {
  registerPath('/auth/app-tokens', {
    post: {
      summary: 'Create an app token',
      tags: ['auth'],
      security: AUTH_REQUIRED,
      requestBody: {
        content: { 'application/json': { schema: BodySchema } },
      },
      responses: {
        200: {
          content: { 'application/json': { schema: ResponseSchema } },
        },
        400: {},
        401: {},
      },
    },
  });

  router.post(
    '/app-tokens',
    acceptValidator('application/json'),
    authenticator(true),
    async (ctx) => {
      let body;

      try {
        body = BodySchema.parse(ctx.request.body);
      } catch (err) {
        return ctx.throw(400, err as Error);
      }

      const expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;

      if (expiresAt && !isValidExpiresAt(expiresAt)) {
        ctx.throw(400, 'expiresAt must be in the future and before 2038');
      }

      const token = generateAppToken();

      const row = await runInTransaction(async (conn) => {
        const { insertId } = await conn.query<{ insertId: number }>(sql`
          INSERT INTO appToken SET
            userId = ${ctx.state.user!.id},
            tokenHash = ${hashAppToken(token)},
            note = ${body.note || null},
            scopes = ${JSON.stringify([...new Set(body.scopes)])},
            expiresAt = ${expiresAt}
        `);

        const [row] = await conn.query<object[]>(
          sql`SELECT ${raw(APP_TOKEN_COLUMNS_SQL)} FROM appToken WHERE id = ${insertId}`,
        );

        return row;
      });

      ctx.body = ResponseSchema.parse({ ...row, token });
    },
  );
}
