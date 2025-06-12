import { Middleware } from 'koa';
import sql from 'sql-template-tag';
import { pool } from './database.js';
import { User } from './koaTypes.js';

export const authProviderToColumn = {
  facebook: 'facebookUserId',
  osm: 'osmId',
  garmin: 'garminUserId',
  google: 'googleUserId',
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

    const [userRow] = await pool.query(sql`
      SELECT user.*
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

    ctx.state.user = rowToUser(userRow, authToken);

    await next();
  };
}

export function rowToUser(row: any, authToken: string): User {
  return {
    ...row,
    isAdmin: Boolean(row.isAdmin),
    authProviders: Object.entries(row)
      .filter(([column, value]) => value && column in columnToAuthProvider)
      .map(([column]) => columnToAuthProvider[column]),
    authToken,
    settings: row.settings ? JSON.parse(row.settings) : row.settings,
  };
}

export function userForResponse(user: User) {
  const {
    authProviders,
    authToken,
    email,
    id,
    isAdmin,
    language,
    lat,
    lon,
    name,
    premiumExpiration,
    sendGalleryEmails,
    settings,
  } = user;

  return {
    authProviders,
    authToken,
    email,
    id,
    isAdmin,
    language,
    lat,
    lon,
    name,
    premiumExpiration: premiumExpiration?.toISOString(),
    sendGalleryEmails: Boolean(sendGalleryEmails),
    settings,
  };
}
