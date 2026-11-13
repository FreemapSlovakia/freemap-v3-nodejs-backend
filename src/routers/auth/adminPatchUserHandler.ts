import type { RouterInstance } from '@koa/router';
import sql, { join, raw } from 'sql-template-tag';
import z from 'zod';
import { deleteRoleTokens, refuseRoleHolderForToken } from '../../appTokens.js';
import { authenticator } from '../../authenticator.js';
import { pool, runInTransaction } from '../../database.js';
import { emailFieldsSql, nextEmail } from '../../emailAddress.js';
import { AUTH_REQUIRED, registerPath } from '../../openapi.js';
import { hasRole } from '../../roles.js';
import { idParam } from '../../routeParams.js';
import {
  CommonUserSchema,
  removesLastWayIn,
  USER_COLUMNS_SQL,
  UserRowSchema,
} from '../../types.js';
import { summarize, UserSummarySchema } from './userSummary.js';

const BodySchema = z
  .object(CommonUserSchema)
  .pick({
    name: true,
    email: true,
    description: true,
    language: true,
    sendGalleryEmails: true,
    roles: true,
    credits: true,
  })
  .extend({ premiumExpiration: z.iso.datetime().nullable() })
  .partial()
  .strict()
  .refine((data) => Object.values(data).some((v) => v !== undefined), {
    message: 'At least one field must be provided',
  });

const asWriter = authenticator(true, 'users:write');

export function attachAdminPatchUserHandler(router: RouterInstance) {
  registerPath('/auth/users/{id}', {
    patch: {
      summary: 'Update a user (admin only)',
      tags: ['auth'],
      security: AUTH_REQUIRED,
      requestParams: { path: z.object({ id: z.coerce.number().int() }) },
      requestBody: {
        content: { 'application/json': { schema: BodySchema } },
      },
      responses: {
        200: {
          content: { 'application/json': { schema: UserSummarySchema } },
        },
        400: {},
        401: {},
        403: {
          description:
            'Not a userManager, or an app token without users:write, changing roles or email, or changing an account holding roles',
        },
        404: {},
        409: { description: "The email is the account's only way in" },
      },
    },
  });

  router.patch('/users/:id', asWriter, async (ctx) => {
    if (!hasRole(ctx.state.user, 'userManager')) {
      return ctx.throw(403);
    }

    let body;

    try {
      body = BodySchema.parse(ctx.request.body);
    } catch (err) {
      return ctx.throw(400, err as Error);
    }

    // Either outlasts the token: a role mints more, an email logs in.
    if (
      ctx.state.user!.appToken &&
      (body.roles !== undefined || body.email !== undefined)
    ) {
      return ctx.throw(403, 'roles and email change only in a login session');
    }

    const id = idParam(ctx, 'no such user');

    const assignments = Object.entries(body)
      .filter(([key, value]) => key !== 'email' && value !== undefined)
      .map(([key, value]) =>
        key === 'premiumExpiration'
          ? sql`premiumExpiration = ${value ? new Date(value as string) : null}`
          : key === 'roles'
            ? sql`roles = ${JSON.stringify(value)}`
            : sql`${raw(key)} = ${value}`,
      );

    await runInTransaction(async (conn) => {
      // Under the lock, as the disconnect handler reads it.
      const [found] = await conn.query<unknown[]>(
        sql`SELECT ${raw(USER_COLUMNS_SQL)} FROM user WHERE id = ${id} FOR UPDATE`,
      );

      if (!found) {
        return ctx.throw(404);
      }

      const row = UserRowSchema.parse(found);

      refuseRoleHolderForToken(ctx, row);

      // Per attempt: a retried transaction starts again from the row it reads.
      const sets = [...assignments];

      if (body.email !== undefined) {
        // Unproven: an admin doesn't receive the owner's mail.
        const next = nextEmail(row, body.email);

        if (removesLastWayIn(row, next.emailVerified)) {
          return ctx.throw(409, 'last provider');
        }

        // The user published the address they had, not one an admin sets.
        sets.push(
          emailFieldsSql(next),
          sql`publicFields = ${JSON.stringify(row.publicFields.filter((f) => f !== 'email'))}`,
        );
      }

      if (sets.length > 0) {
        await conn.query<unknown>(
          sql`UPDATE user SET ${join(sets)} WHERE id = ${id}`,
        );
      }

      // A role taken away takes its tokens, so granting it again won't revive them.
      if (body.roles) {
        await deleteRoleTokens(conn, id, body.roles);
      }
    });

    const [row] = await pool.query<unknown[]>(
      sql`SELECT ${raw(USER_COLUMNS_SQL)} FROM user WHERE id = ${id}`,
    );

    ctx.body = summarize(UserRowSchema.parse(row));
  });
}
