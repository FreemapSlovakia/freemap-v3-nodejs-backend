import type { Context, Middleware } from 'koa';
import sql, { raw } from 'sql-template-tag';
import z from 'zod';
import {
  APP_TOKEN_PREFIX,
  type AppTokenScope,
  AppTokenScopeSchema,
  hashAppToken,
} from './appTokens.js';
import { pool } from './database.js';
import type { User } from './koaTypes.js';
import { appLogger } from './logger.js';
import {
  USER_COLUMNS_SQL_PREFIXED,
  type UserRow,
  UserRowSchema,
} from './types.js';

const SessionStaleSchema = z.object({ sessionStale: z.coerce.boolean() });

const AppTokenColumnsSchema = z.object({
  appTokenId: z.uint32(),
  // Unknown entries are dropped so retiring a scope doesn't break old tokens.
  appTokenScopes: z
    .array(z.string())
    .transform((scopes) =>
      scopes.filter(
        (scope): scope is AppTokenScope =>
          AppTokenScopeSchema.safeParse(scope).success,
      ),
    ),
});

const logger = appLogger.child({ module: 'authenticator' });

export const authProviderToColumn = {
  facebook: 'facebookUserId',
  osm: 'osmId',
  garmin: 'garminUserId',
  google: 'googleUserId',
  apple: 'appleUserId',
  github: 'githubUserId',
  strava: 'stravaUserId',
  microsoft: 'microsoftUserId',
} as const;

export const columnToAuthProvider = Object.fromEntries(
  Object.entries(authProviderToColumn).map(([k, v]) => [v, k]),
);

/**
 * App tokens are refused unless `scope` is given and the token holds it, so a
 * route stays closed to them until it opts in. `'any'` admits every app token
 * and leaves the scope check to the handler.
 */
export function authenticator(
  require?: boolean,
  scope?: AppTokenScope | 'any',
): Middleware {
  return async function authorize(ctx, next) {
    let authToken = Array.isArray(ctx.query.authToken)
      ? ctx.query.authToken[0]
      : ctx.query.authToken; // used in websockets

    if (!authToken) {
      const ah = ctx.get('Authorization');

      const m = /^bearer (.+)$/i.exec(ah || '');

      if (!m) {
        if (require) {
          ctx.set(
            'WWW-Authenticate',
            'Bearer realm="freemap"; error="missing token"',
          );

          ctx.throw(401, 'missing token');
        }

        await next();

        return;
      }

      authToken = m[1];
    }

    const isAppToken = authToken.startsWith(APP_TOKEN_PREFIX);

    const user = isAppToken
      ? await authenticateAppToken(ctx, authToken)
      : await authenticateSession(authToken);

    if (!user) {
      // A bad app token fails even where login is optional, so a client sees
      // 401 rather than a misleading anonymous answer such as 402.
      if (require || isAppToken) {
        ctx.set(
          'WWW-Authenticate',
          `Bearer realm="freemap"; error="invalid authorization"`,
        );

        ctx.throw(401, `invalid authorization`);
      }

      await next();

      return;
    }

    if (
      user.appToken &&
      scope !== 'any' &&
      !(scope && user.appToken.scopes.includes(scope))
    ) {
      ctx.set(
        'WWW-Authenticate',
        `Bearer realm="freemap"; error="insufficient_scope"${scope ? `; scope="${scope}"` : ''}`,
      );

      ctx.throw(
        403,
        scope
          ? `app token lacks scope ${scope}`
          : 'not available to app tokens',
      );
    }

    ctx.state.user = user;

    await next();
  };
}

async function authenticateSession(authToken: string) {
  const [userRow] = await pool.query<unknown[]>(sql`
    SELECT ${raw(USER_COLUMNS_SQL_PREFIXED)},
      auth.lastUsedAt < NOW() - INTERVAL 1 HOUR AS sessionStale
    FROM user INNER JOIN auth ON (userId = id)
    WHERE authToken = ${authToken}
  `);

  if (!userRow) {
    return undefined;
  }

  // Stamp the session as used so cleanup() can expire it on inactivity.
  // Throttled: the window is months wide, so an hour of drift is irrelevant
  // and a write on every authenticated request would not be. Compared in SQL
  // so the Node and DB timezones can't disagree; not awaited, since a failed
  // stamp must not fail the request.
  if (SessionStaleSchema.parse(userRow).sessionStale) {
    pool
      .query<unknown>(
        sql`UPDATE auth SET lastUsedAt = NOW() WHERE authToken = ${authToken}`,
      )
      .catch((err) => {
        logger.warn({ err }, 'Failed to stamp session as used.');
      });
  }

  return rowToUser(UserRowSchema.parse(userRow), authToken);
}

async function authenticateAppToken(ctx: Context, authToken: string) {
  const userAgent = ctx.get('User-Agent').slice(0, 255) || null;

  const [userRow] = await pool.query<unknown[]>(sql`
    SELECT ${raw(USER_COLUMNS_SQL_PREFIXED)},
      appToken.id AS appTokenId,
      appToken.scopes AS appTokenScopes,
      (appToken.lastUsedAt IS NULL
        OR appToken.lastUsedAt < NOW() - INTERVAL 1 HOUR
        OR NOT (appToken.lastUserAgent <=> ${userAgent})) AS sessionStale
    FROM user INNER JOIN appToken ON (appToken.userId = user.id)
    WHERE appToken.tokenHash = ${hashAppToken(authToken)}
      AND (appToken.expiresAt IS NULL OR appToken.expiresAt > NOW())
  `);

  if (!userRow) {
    return undefined;
  }

  const { appTokenId, appTokenScopes } = AppTokenColumnsSchema.parse(userRow);

  // Throttled like the session stamp, but a new user agent is written at once:
  // it is what tells the owner which client uses the token.
  if (SessionStaleSchema.parse(userRow).sessionStale) {
    pool
      .query<unknown>(
        sql`UPDATE appToken SET lastUsedAt = NOW(), lastUserAgent = ${userAgent} WHERE id = ${appTokenId}`,
      )
      .catch((err) => {
        logger.warn({ err }, 'Failed to stamp app token as used.');
      });
  }

  return rowToUser(UserRowSchema.parse(userRow), authToken, {
    id: appTokenId,
    scopes: appTokenScopes,
  });
}

export function rowToUser(
  row: UserRow,
  authToken: string,
  appToken: User['appToken'] = null,
): User {
  return {
    ...row,
    authProviders: Object.entries(row)
      .filter(([column, value]) => value && column in columnToAuthProvider)
      .map(([column]) => columnToAuthProvider[column]),
    authToken,
    appToken,
    isAdmin: row.roles.length > 0,
    osmGpxAuthorized: row.osmAccessToken !== null,
  };
}
