import type { RouterInstance } from '@koa/router';
import sql, { join, raw } from 'sql-template-tag';
import z from 'zod';
import { authenticator } from '../../authenticator.js';
import { pool } from '../../database.js';
import { AUTH_REQUIRED, registerPath } from '../../openapi.js';
import { hasRole } from '../../roles.js';
import {
  CommonUserSchema,
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
        403: {},
        404: {},
      },
    },
  });

  router.patch('/users/:id', authenticator(true), async (ctx) => {
    if (!hasRole(ctx.state.user, 'userManager')) {
      return ctx.throw(403);
    }

    let body;

    try {
      body = BodySchema.parse(ctx.request.body);
    } catch (err) {
      return ctx.throw(400, err as Error);
    }

    const id = Number(ctx.params.id);

    const assignments = Object.entries(body)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) =>
        key === 'premiumExpiration'
          ? sql`premiumExpiration = ${value ? new Date(value as string) : null}`
          : key === 'roles'
            ? sql`roles = ${JSON.stringify(value)}`
            : sql`${raw(key)} = ${value}`,
      );

    const result = await pool.query<{ affectedRows: number }>(
      sql`UPDATE user SET ${join(assignments)} WHERE id = ${id}`,
    );

    // foundRows defaults to true, so affectedRows counts matched (not just
    // changed) rows — 0 means no such user.
    if (result.affectedRows === 0) {
      return ctx.throw(404);
    }

    const [row] = await pool.query<unknown[]>(
      sql`SELECT ${raw(USER_COLUMNS_SQL)} FROM user WHERE id = ${id}`,
    );

    ctx.body = summarize(UserRowSchema.parse(row));
  });
}
