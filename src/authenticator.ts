import type { Middleware } from 'koa';
import sql, { raw } from 'sql-template-tag';
import z from 'zod';
import { pool } from './database.js';
import type { User } from './koaTypes.js';
import { appLogger } from './logger.js';
import {
  USER_COLUMNS_SQL_PREFIXED,
  type UserRow,
  UserRowSchema,
} from './types.js';

const SessionStaleSchema = z.object({ sessionStale: z.coerce.boolean() });

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

export function authenticator(require?: boolean): Middleware {
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

    const [userRow] = await pool.query<unknown[]>(sql`
      SELECT ${raw(USER_COLUMNS_SQL_PREFIXED)},
        auth.lastUsedAt < NOW() - INTERVAL 1 HOUR AS sessionStale
      FROM user INNER JOIN auth ON (userId = id)
      WHERE authToken = ${authToken}
    `);

    if (!userRow) {
      if (require) {
        ctx.set(
          'WWW-Authenticate',
          `Bearer realm="freemap"; error="invalid authorization"`,
        );

        ctx.throw(401, `invalid authorization`);
      }

      await next();

      return;
    }

    ctx.state.user = rowToUser(UserRowSchema.parse(userRow), authToken);

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

    await next();
  };
}

export function rowToUser(row: UserRow, authToken: string): User {
  return {
    ...row,
    authProviders: Object.entries(row)
      .filter(([column, value]) => value && column in columnToAuthProvider)
      .map(([column]) => columnToAuthProvider[column]),
    authToken,
    isAdmin: row.roles.length > 0,
  };
}
