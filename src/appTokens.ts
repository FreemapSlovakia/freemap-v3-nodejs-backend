import { createHash, randomBytes } from 'node:crypto';
import type { PoolConnection } from 'mariadb';
import sql, { join } from 'sql-template-tag';
import z from 'zod';
import type { User } from './koaTypes.js';
import { hasRole, type Role } from './roles.js';
import { zDateToIso, zNullableDateToIso } from './types.js';

// Session tokens are base64, so they never carry this prefix.
export const APP_TOKEN_PREFIX = 'fm_';

export const AppTokenScopeSchema = z
  .enum([
    'gallery:read',
    'gallery:write',
    'maps:read',
    'maps:write',
    'events:read',
    'events:write',
    'tracking:read',
    'tracking:write',
    'tiles:outdoor',
    'tiles:shading',
    'tiles:aerial',
    'users:read',
    'users:write',
  ])
  .meta({ id: 'AppTokenScope' });

export type AppTokenScope = z.infer<typeof AppTokenScopeSchema>;

/** Scopes only a holder of the role may put on a token; routes check it again. */
const SCOPE_ROLES: Partial<Record<AppTokenScope, Role>> = {
  'users:read': 'userManager',
  'users:write': 'userManager',
};

/** The role a stored scope needs, if any; a retired scope needs none. */
const roleOf = (scope: string): Role | undefined =>
  Object.hasOwn(SCOPE_ROLES, scope)
    ? SCOPE_ROLES[scope as AppTokenScope]
    : undefined;

/** Deletes `userId`'s tokens holding a scope whose role `roles` lacks. */
export async function deleteRoleTokens(
  conn: PoolConnection,
  userId: number,
  roles: readonly Role[],
) {
  const lacking = Object.keys(SCOPE_ROLES).filter(
    (scope) => !roles.includes(roleOf(scope)!),
  );

  if (lacking.length > 0) {
    await conn.query<unknown>(
      sql`DELETE FROM appToken WHERE userId = ${userId} AND (${join(
        lacking.map(
          (scope) => sql`JSON_CONTAINS(scopes, ${JSON.stringify(scope)})`,
        ),
        ' OR ',
      )})`,
    );
  }
}

// A role scope reaches other people's accounts, so its token lives briefly.
const ROLE_SCOPE_MAX_DAYS = 7;

// The client computes "in 7 days" by its own clock.
const CLOCK_SKEW_MS = 3_600_000;

/**
 * Why `user` may not hold a token with `scopes` until `expiresAt`, or null.
 * The limit counts from `createdAt`, so an edit can't extend it.
 */
export function scopesRefusal(
  user: User | undefined,
  scopes: readonly string[],
  expiresAt: Date | null,
  createdAt = new Date(),
): { status: 400 | 403; message: string } | null {
  const roleScopes = scopes.flatMap((scope) => {
    const role = roleOf(scope);

    return role ? [{ scope, role }] : [];
  });

  for (const { scope, role } of roleScopes) {
    if (!hasRole(user, role)) {
      return { status: 403, message: `scope ${scope} needs the ${role} role` };
    }
  }

  if (
    roleScopes.length > 0 &&
    (!expiresAt ||
      expiresAt.getTime() >
        createdAt.getTime() + ROLE_SCOPE_MAX_DAYS * 86_400_000 + CLOCK_SKEW_MS)
  ) {
    return {
      status: 400,
      message: `a token with ${roleScopes.map((s) => s.scope).join(', ')} must expire within ${ROLE_SCOPE_MAX_DAYS} days of its creation`,
    };
  }

  return null;
}

/**
 * Throws 403 when an app token would change an account holding roles: a
 * login put there would outlast the token.
 */
export function refuseRoleHolderForToken(
  ctx: {
    state: { user?: User };
    throw: (status: number, msg: string) => never;
  },
  ...accounts: { roles: readonly Role[] }[]
) {
  if (
    ctx.state.user?.appToken &&
    accounts.some((account) => account.roles.length > 0)
  ) {
    ctx.throw(403, 'an account holding roles changes only in a login session');
  }
}

export const AppTokenSchema = z
  .strictObject({
    id: z.uint32(),
    note: z.string().nullable(),
    scopes: z.array(z.string()),
    createdAt: zDateToIso,
    expiresAt: zNullableDateToIso,
    lastUsedAt: zNullableDateToIso,
    lastUserAgent: z.string().nullable(),
  })
  .meta({ id: 'AppToken' });

// The column is a TIMESTAMP.
const MAX_EXPIRES_AT = new Date('2038-01-01T00:00:00Z');

export function isValidExpiresAt(expiresAt: Date) {
  return expiresAt > new Date() && expiresAt <= MAX_EXPIRES_AT;
}

export const APP_TOKEN_COLUMNS_SQL =
  'id, note, scopes, createdAt, expiresAt, lastUsedAt, lastUserAgent';

export function generateAppToken() {
  return APP_TOKEN_PREFIX + randomBytes(32).toString('base64url');
}

export function hashAppToken(token: string) {
  return createHash('sha256').update(token).digest();
}
