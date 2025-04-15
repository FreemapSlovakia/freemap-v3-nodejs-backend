import { Middleware } from 'koa';
import sql from 'sql-template-tag';
import { pool } from './database.js';

export const authProviderToColumn = {
  facebook: 'facebookUserId',
  osm: 'osmId',
  garmin: 'garminUserId',
  google: 'googleUserId',
};

export const columnToAuthProvider = Object.fromEntries(
  Object.entries(authProviderToColumn).map(([k, v]) => [v, k]),
);

export function authenticator(require?: boolean): Middleware {
  return async function authorize(ctx, next) {
    let { authToken } = ctx.query; // used in websockets

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
      SELECT user.*, DATEDIFF(NOW(), lastPaymentAt) <= 365 OR EXISTS (
        SELECT 1 FROM purchase WHERE DATEDIFF(NOW(), createdAt) <= 365 AND userId = id
      ) AS isPremium
      FROM user INNER JOIN auth ON (userId = id)
      WHERE authToken = ${authToken as any}
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

    ctx.state.user = {
      ...userRow,
      ...userForResponse({ ...userRow, authToken }),
    };

    await next();
  };
}

export function userForResponse(user: any) {
  const {
    id,
    name,
    email,
    language,
    lat,
    lon,
    sendGalleryEmails,
    isAdmin,
    settings,
    isPremium,
    authToken,
  } = user;

  return {
    id,
    name,
    email,
    isAdmin: Boolean(isAdmin),
    lat,
    lon,
    settings: typeof settings === 'string' ? JSON.parse(settings) : settings,
    sendGalleryEmails: Boolean(sendGalleryEmails),
    language,
    isPremium: Boolean(isPremium),
    authToken,
    authProviders:
      user.authProviders ??
      Object.entries(user)
        .filter(([column, value]) => value && column in columnToAuthProvider)
        .map(([column]) => columnToAuthProvider[column]),
  };
}
