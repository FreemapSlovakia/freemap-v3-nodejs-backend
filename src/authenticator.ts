import { Middleware } from 'koa';
import sql from 'sql-template-tag';
import { pool } from './database.js';
import { User } from './koaTypes.js';
import { assertGuard } from 'typia';

export const authProviderToColumn = {
  facebook: 'facebookUserId',
  osm: 'osmId',
  garmin: 'garminUserId',
  google: 'googleUserId',
} as const;

export const columnToAuthProvider = Object.fromEntries(
  Object.entries(authProviderToColumn).map(([k, v]) => [v, k]),
);

export type UserRow = {
  id: number;
  osmId: number | null;
  facebookUserId: string | null;
  googleUserId: string | null;
  garminUserId: string | null;
  garminAccessToken: string | null;
  garminAccessTokenSecret: string | null;
  name: string;
  email: string | null;
  isAdmin: 0 | 1;
  createdAt: Date;
  lat: number | null;
  lon: number | null;
  settings: string;
  sendGalleryEmails: 0 | 1;
  premiumExpiration: Date | null;
  credits: number;
  language: string | null;
};

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

    assertGuard<UserRow>(userRow);

    ctx.state.user = rowToUser(userRow, authToken);

    await next();
  };
}

export function rowToUser(row: UserRow, authToken: string): User {
  return {
    ...row,
    isAdmin: Boolean(row.isAdmin),
    authProviders: Object.entries(row)
      .filter(([column, value]) => value && column in columnToAuthProvider)
      .map(([column]) => columnToAuthProvider[column]),
    authToken,
    settings: row.settings ? JSON.parse(row.settings) : row.settings,
    sendGalleryEmails: Boolean(row.sendGalleryEmails),
  };
}

export function userForResponse(user: User) {
  const {
    authProviders,
    authToken,
    credits,
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
    credits,
    email,
    id,
    isAdmin,
    language,
    lat,
    lon,
    name,
    premiumExpiration: premiumExpiration?.toISOString() ?? null,
    sendGalleryEmails: Boolean(sendGalleryEmails),
    settings,
  };
}
