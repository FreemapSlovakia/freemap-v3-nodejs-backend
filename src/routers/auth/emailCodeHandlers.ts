import type { RouterInstance } from '@koa/router';
import type { ParameterizedContext } from 'koa';
import sql, { raw } from 'sql-template-tag';
import z from 'zod';
import { authenticator, rowToUser } from '../../authenticator.js';
import { pool, runInTransaction } from '../../database.js';
import {
  emailChangeSql,
  nextEmail,
  normalizeEmail,
} from '../../emailAddress.js';
import { checkEmailCode, sendEmailCode } from '../../emailCodes.js';
import { AUTH_OPTIONAL, AUTH_REQUIRED, registerPath } from '../../openapi.js';
import { acceptValidator } from '../../requestValidators.js';
import {
  LoginResponseSchema,
  USER_COLUMNS_SQL,
  UserResponseSchema,
  UserRowSchema,
} from '../../types.js';
import {
  MergeConflictError,
  mergeUserAccounts,
  olderFirst,
} from '../../userMerge.js';
import {
  findByVerifiedEmail,
  LoginSettingsSchema,
  loginWithEmail,
  startSession,
  VERIFIED_EMAIL_RETRY,
} from './loginProcessor.js';

const EmailSchema = z.email().max(255);

const CodeSchema = z.string().regex(/^\d{6}$/);

const SendBodySchema = z.object({
  email: EmailSchema,
  language: z.string().nullish(),
});

// All of it checked before the code is, which spends it.
const LoginBodySchema = z.strictObject({
  email: EmailSchema,
  code: CodeSchema,
  language: z.string().length(2).nullable(),
  // As the other logins take it, for a new account's home location.
  settings: LoginSettingsSchema.optional(),
});

const ChangeBodySchema = z.strictObject({
  email: EmailSchema,
  code: CodeSchema,
});

/**
 * Whether an account but `exceptId` has `email` verified: findByVerifiedEmail's
 * match, read without its lock, for a mail's note.
 */
async function verifiedElsewhere(email: string, exceptId = 0) {
  const rows = await pool.query<unknown[]>(
    sql`SELECT 1 FROM user
      WHERE verifiedEmailKey = ${normalizeEmail(email)} AND id <> ${exceptId}
      LIMIT 1`,
  );

  return rows.length > 0;
}

function parse<T extends z.ZodType>(
  schema: T,
  ctx: ParameterizedContext,
): z.infer<T> {
  try {
    return schema.parse(ctx.request.body);
  } catch (err) {
    return ctx.throw(400, err as Error);
  }
}

export function attachEmailCodeHandlers(router: RouterInstance) {
  registerPath('/auth/email-login-code', {
    post: {
      summary: 'Email a code to log in with',
      tags: ['auth'],
      security: AUTH_OPTIONAL,
      requestBody: {
        content: { 'application/json': { schema: SendBodySchema } },
      },
      responses: { 204: {}, 400: {}, 429: { description: 'Sent too often' } },
    },
  });

  router.post(
    '/email-login-code',
    acceptValidator('application/json'),
    async (ctx) => {
      const { email, language } = parse(SendBodySchema, ctx);

      await sendEmailCode(ctx, 'login', email, language, null, async () =>
        (await verifiedElsewhere(email)) ? undefined : 'newAccount',
      );

      ctx.status = 204;
    },
  );

  registerPath('/auth/login-email', {
    post: {
      summary: 'Log in with a code sent by email',
      description:
        'Logs into the account with this address verified, or creates one.',
      tags: ['auth'],
      security: AUTH_OPTIONAL,
      requestBody: {
        content: { 'application/json': { schema: LoginBodySchema } },
      },
      responses: {
        200: {
          content: { 'application/json': { schema: LoginResponseSchema } },
        },
        400: {},
        403: { description: 'Wrong or expired code' },
        429: { description: 'Too many attempts at this address today' },
      },
    },
  });

  router.post(
    '/login-email',
    acceptValidator('application/json'),
    async (ctx) => {
      const { email, code, language, settings } = parse(LoginBodySchema, ctx);

      await checkEmailCode(ctx, 'login', email, code);

      await loginWithEmail(ctx, email, language, settings);
    },
  );

  registerPath('/auth/email-change-code', {
    post: {
      summary: "Email a code confirming the account's new address",
      tags: ['auth'],
      security: AUTH_REQUIRED,
      requestBody: {
        content: { 'application/json': { schema: SendBodySchema } },
      },
      responses: {
        204: {},
        400: {},
        401: {},
        429: { description: 'Sent too often' },
      },
    },
  });

  router.post(
    '/email-change-code',
    authenticator(true),
    acceptValidator('application/json'),
    async (ctx) => {
      const { email, language } = parse(SendBodySchema, ctx);

      const user = ctx.state.user!;

      // Whether another account has it is told only in the mail, to the one
      // who gets the code: the response would reveal who is registered.
      await sendEmailCode(
        ctx,
        'change',
        email,
        language ?? user.language,
        user.id,
        async () =>
          (await verifiedElsewhere(email, user.id)) ? 'joins' : undefined,
      );

      ctx.status = 204;
    },
  );

  registerPath('/auth/email', {
    put: {
      summary: "Set the account's email to an address a code was sent to",
      tags: ['auth'],
      security: AUTH_REQUIRED,
      requestBody: {
        content: { 'application/json': { schema: ChangeBodySchema } },
      },
      responses: {
        200: {
          description:
            'The account, with any other one that had the address verified merged into it',
          content: { 'application/json': { schema: UserResponseSchema } },
        },
        400: {},
        401: {},
        403: { description: 'Wrong or expired code' },
        429: { description: 'Too many attempts at this address today' },
        409: {
          description:
            'Another account with this address verified has a conflicting login provider',
        },
      },
    },
  });

  router.put(
    '/email',
    authenticator(true),
    acceptValidator('application/json'),
    async (ctx) => {
      const { email, code } = parse(ChangeBodySchema, ctx);

      const { id: userId, authToken } = ctx.state.user!;

      await checkEmailCode(ctx, 'change', email, code, userId);

      const emailKey = normalizeEmail(email);

      // One verifying the address elsewhere meanwhile makes this fail on the
      // unique index; the retry merges that account too.
      const { row, token } = await runInTransaction(async (conn) => {
        const lock = async (id: number) => {
          const [found] = await conn.query<unknown[]>(
            sql`SELECT ${raw(USER_COLUMNS_SQL)} FROM user WHERE id = ${id} FOR UPDATE`,
          );

          if (!found) {
            return ctx.throw(401, 'account gone');
          }

          return UserRowSchema.parse(found);
        };

        // This account first, then the other, as the login's connect locks them.
        const current = await lock(userId);

        // The code proves the mailbox, which already opens the account that has
        // it verified: that is the same person's, so the two are joined, into
        // the older one.
        const other = await findByVerifiedEmail(conn, emailKey, userId);

        let keptId = userId;

        if (other) {
          const [target, source] = olderFirst(current, other);

          try {
            await mergeUserAccounts(conn, target, source);
          } catch (err) {
            if (err instanceof MergeConflictError) {
              ctx.throw(409, 'conflicting providers');
            }

            throw err;
          }

          keptId = target.id;
        }

        const kept = await lock(keptId);

        await conn.query<unknown>(
          sql`UPDATE user SET ${emailChangeSql(kept, nextEmail(kept, email, { proven: true }))}
          WHERE id = ${keptId}`,
        );

        return {
          row: await lock(keptId),
          // Merged into the older one, this account's sessions are gone.
          token:
            keptId === userId
              ? authToken
              : await startSession(conn, keptId, new Date()),
        };
      }, VERIFIED_EMAIL_RETRY);

      ctx.body = UserResponseSchema.parse(rowToUser(row, token));
    },
  );
}
