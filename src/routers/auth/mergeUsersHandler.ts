import { RouterInstance } from '@koa/router';
import sql, { raw } from 'sql-template-tag';
import z from 'zod';
import { authenticator } from '../../authenticator.js';
import { pool, runInTransaction } from '../../database.js';
import { AUTH_REQUIRED, registerPath } from '../../openapi.js';
import {
  USER_COLUMNS_SQL,
  UserRow,
  UserRowSchema,
  zDateToIso,
  zNullableDateToIso,
} from '../../types.js';
import { MergeConflictError, mergeUserAccounts } from '../../userMerge.js';

const PROVIDER_FIELDS = [
  'osmId',
  'facebookUserId',
  'googleUserId',
  'garminUserId',
  'appleUserId',
  'githubUserId',
  'stravaUserId',
  'microsoftUserId',
] as const;

const UserSummarySchema = z
  .strictObject({
    id: z.uint32(),
    name: z.string(),
    email: z.email().nullable(),
    createdAt: zDateToIso,
    premiumExpiration: zNullableDateToIso,
    credits: z.number(),
    isAdmin: z.boolean(),
    hasPicture: z.boolean(),
    providers: z.record(
      z.enum(PROVIDER_FIELDS),
      z.union([z.string(), z.number()]),
    ),
  })
  .meta({ id: 'UserSummary' });

const MergeBodySchema = z.strictObject({
  sourceId: z.uint32(),
  force: z.boolean().optional(),
});

function summarize(user: UserRow) {
  return UserSummarySchema.parse({
    id: user.id,
    name: user.name,
    email: user.email,
    createdAt: user.createdAt,
    premiumExpiration: user.premiumExpiration,
    credits: user.credits,
    isAdmin: user.isAdmin,
    hasPicture: user.hasPicture,
    providers: Object.fromEntries(
      PROVIDER_FIELDS.filter((c) => user[c] != null).map((c) => [c, user[c]]),
    ),
  });
}

export function attachMergeUsersHandler(router: RouterInstance) {
  registerPath('/auth/users/{id}', {
    get: {
      summary: 'Get merge-relevant details of a user (admin only)',
      tags: ['auth'],
      security: AUTH_REQUIRED,
      requestParams: { path: z.object({ id: z.coerce.number().int() }) },
      responses: {
        200: {
          content: { 'application/json': { schema: UserSummarySchema } },
        },
        401: {},
        403: {},
        404: {},
      },
    },
  });

  router.get('/users/:id', authenticator(true), async (ctx) => {
    if (!ctx.state.user!.isAdmin) {
      return ctx.throw(403);
    }

    const id = Number(ctx.params.id);

    const [row] = await pool.query<unknown[]>(
      sql`SELECT ${raw(USER_COLUMNS_SQL)} FROM user WHERE id = ${id}`,
    );

    if (!row) {
      return ctx.throw(404);
    }

    ctx.body = summarize(UserRowSchema.parse(row));
  });

  registerPath('/auth/users/{targetId}/merge', {
    post: {
      summary: 'Merge another account into this one (admin only)',
      description:
        'Merges `sourceId` into `targetId`; the source account is deleted ' +
        'and the target keeps the consolidated data. Fails with 409 on ' +
        'conflicting auth-provider IDs unless `force` is set, in which case ' +
        "the target's provider IDs are kept and the source's are dropped.",
      tags: ['auth'],
      security: AUTH_REQUIRED,
      requestParams: { path: z.object({ targetId: z.coerce.number().int() }) },
      requestBody: {
        content: { 'application/json': { schema: MergeBodySchema } },
      },
      responses: {
        200: {
          content: { 'application/json': { schema: UserSummarySchema } },
        },
        400: {},
        401: {},
        403: {},
        404: {},
        409: {},
      },
    },
  });

  router.post('/users/:targetId/merge', authenticator(true), async (ctx) => {
    if (!ctx.state.user!.isAdmin) {
      return ctx.throw(403);
    }

    let body;

    try {
      body = MergeBodySchema.parse(ctx.request.body);
    } catch (err) {
      return ctx.throw(400, err as Error);
    }

    const targetId = Number(ctx.params.targetId);
    const { sourceId, force } = body;

    if (targetId === sourceId) {
      return ctx.throw(400, 'targetId and sourceId must differ');
    }

    const merged = await runInTransaction(async (conn) => {
      const [tRow] = await conn.query<unknown[]>(
        sql`SELECT ${raw(USER_COLUMNS_SQL)} FROM user WHERE id = ${targetId} FOR UPDATE`,
      );

      const [sRow] = await conn.query<unknown[]>(
        sql`SELECT ${raw(USER_COLUMNS_SQL)} FROM user WHERE id = ${sourceId} FOR UPDATE`,
      );

      if (!tRow) {
        return ctx.throw(404, `no user with id ${targetId} (target)`);
      }

      if (!sRow) {
        return ctx.throw(404, `no user with id ${sourceId} (source)`);
      }

      try {
        await mergeUserAccounts(
          conn,
          UserRowSchema.parse(tRow),
          UserRowSchema.parse(sRow),
          { force },
        );
      } catch (err) {
        if (err instanceof MergeConflictError) {
          return ctx.throw(409, `conflicting ${err.column}`);
        }

        throw err;
      }

      const [row] = await conn.query<unknown[]>(
        sql`SELECT ${raw(USER_COLUMNS_SQL)} FROM user WHERE id = ${targetId}`,
      );

      return summarize(UserRowSchema.parse(row));
    });

    ctx.body = merged;
  });
}
