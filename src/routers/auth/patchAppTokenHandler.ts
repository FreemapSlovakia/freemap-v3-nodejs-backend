import type { RouterInstance } from '@koa/router';
import sql, { join, raw, type Sql } from 'sql-template-tag';
import z from 'zod';
import {
  APP_TOKEN_COLUMNS_SQL,
  AppTokenSchema,
  AppTokenScopeSchema,
  isValidExpiresAt,
  scopesRefusal,
} from '../../appTokens.js';
import { authenticator } from '../../authenticator.js';
import { runInTransaction } from '../../database.js';
import { AUTH_REQUIRED, registerPath } from '../../openapi.js';
import { acceptValidator } from '../../requestValidators.js';

const BodySchema = z
  .strictObject({
    note: z.string().max(255).nullable().optional(),
    scopes: z.array(AppTokenScopeSchema).min(1).optional(),
    expiresAt: z.iso
      .datetime()
      .nullable()
      .optional()
      .meta({ description: 'null for a token that never expires' }),
  })
  .meta({ id: 'AppTokenPatchBody' });

export function attachPatchAppTokenHandler(router: RouterInstance) {
  registerPath('/auth/app-tokens/{id}', {
    patch: {
      summary: 'Change the note, scopes or expiration of an app token',
      tags: ['auth'],
      security: AUTH_REQUIRED,
      requestParams: {
        path: z.object({ id: z.uint32() }),
      },
      requestBody: {
        content: { 'application/json': { schema: BodySchema } },
      },
      responses: {
        200: {
          content: { 'application/json': { schema: AppTokenSchema } },
        },
        400: {
          description:
            'Also when a token with a role scope (users:*) would expire later than 7 days after its creation',
        },
        401: {},
        403: { description: 'A scope needs a role the user lacks' },
        404: { description: 'no such app token' },
      },
    },
  });

  router.patch(
    '/app-tokens/:id',
    acceptValidator('application/json'),
    authenticator(true),
    async (ctx) => {
      let body;

      try {
        body = BodySchema.parse(ctx.request.body);
      } catch (err) {
        return ctx.throw(400, err as Error);
      }

      const sets: Sql[] = [];

      if (body.note !== undefined) {
        sets.push(sql`note = ${body.note || null}`);
      }

      if (body.scopes) {
        sets.push(sql`scopes = ${JSON.stringify([...new Set(body.scopes)])}`);
      }

      const expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;

      if (body.expiresAt !== undefined) {
        if (expiresAt && !isValidExpiresAt(expiresAt)) {
          ctx.throw(400, 'expiresAt must be in the future and before 2038');
        }

        sets.push(sql`expiresAt = ${expiresAt}`);
      }

      const { id } = ctx.params;

      const userId = ctx.state.user!.id;

      const row = await runInTransaction(async (conn) => {
        const [found] = await conn.query<object[]>(
          sql`SELECT ${raw(APP_TOKEN_COLUMNS_SQL)} FROM appToken WHERE id = ${id} AND userId = ${userId} FOR UPDATE`,
        );

        if (!found) {
          return undefined;
        }

        // The token as it will be: even a note edit is refused while it
        // holds a scope its owner may no longer have.
        const current = AppTokenSchema.parse(found);

        const refusal = scopesRefusal(
          ctx.state.user,
          body.scopes ?? current.scopes,
          body.expiresAt !== undefined
            ? expiresAt
            : current.expiresAt === null
              ? null
              : new Date(current.expiresAt),
          new Date(current.createdAt),
        );

        if (refusal) {
          return ctx.throw(refusal.status, refusal.message);
        }

        if (sets.length) {
          await conn.query(
            sql`UPDATE appToken SET ${join(sets, ', ')} WHERE id = ${id} AND userId = ${userId}`,
          );
        }

        const [row] = await conn.query<object[]>(
          sql`SELECT ${raw(APP_TOKEN_COLUMNS_SQL)} FROM appToken WHERE id = ${id} AND userId = ${userId}`,
        );

        return row;
      });

      if (!row) {
        ctx.throw(404, 'no such app token');
      }

      ctx.body = AppTokenSchema.parse(row);
    },
  );
}
