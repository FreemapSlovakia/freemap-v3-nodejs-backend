import { ParameterizedContext } from 'koa';
import { randomBytes } from 'node:crypto';
import sql, { RawValue, join, raw } from 'sql-template-tag';
import { authProviderToColumn, userForResponse } from '../../authenticator.js';
import { pool } from '../../database.js';

export async function login(
  ctx: ParameterizedContext,
  authProvider: keyof typeof authProviderToColumn,
  remoteUserId: string,
  remoteName: string,
  remoteEmail: string | null,
  remoteLat: number,
  remoteLon: number,
  remoteLanguage: string | null,
  connect = false,
  extraUserFields: Record<string, unknown> = {},
  clientData?: unknown,
) {
  const currentUser = connect ? ctx.state.user : undefined;

  if (connect && !currentUser) {
    connect = false; // let just log in

    // ctx.throw(403, 'unauthenticated');
  }

  const conn = await pool.getConnection();

  let userRow1: Record<string, any>;

  let userId: number;

  let authToken: string;

  try {
    await conn.beginTransaction();

    const [userRow] = await conn.query(
      sql`SELECT * FROM user WHERE ${raw(authProviderToColumn[authProvider])} = ${remoteUserId} FOR UPDATE`,
    );

    userId = (currentUser ?? userRow ?? {}).id;

    const now = new Date();

    if (userRow) {
      // found user in DB for this auth provider

      const authData: Record<string, string> = {};

      for (const col of [
        'garminUserId',
        'garminAccessToken',
        'garminAccessTokenSecret',
        'osmId',
        'facebookUserId',
        'googleUserId',
      ]) {
        authData[col] = userRow[col];
      }

      if (currentUser) {
        if (currentUser[authProviderToColumn[authProvider]]) {
          ctx.throw(400, 'provider already set');
        }

        for (const col of [
          'garminUserId',
          'osmId',
          'facebookUserId',
          'googleUserId',
        ]) {
          if (
            currentUser[col] &&
            userRow[col] &&
            currentUser[col] !== userRow[col]
          ) {
            ctx.throw(400, 'conflicting providers');
          }
        }

        Object.assign(authData, {
          [authProviderToColumn[authProvider]]: remoteUserId,
          ...extraUserFields,
        });

        const {
          id,
          email,
          lat,
          lon,
          language,
          createdAt,
          isAdmin,
          sendGalleryEmails,
          settings,
        } = userRow;

        await conn.query(sql`DELETE FROM auth WHERE userId = ${id}`);

        await Promise.all([
          ...[
            'picture',
            'pictureComment',
            'pictureRating', // TODO may conflict
            'trackingDevice',
            'map',
            'mapWriteAccess', // TODO may conflict
          ].map((table) =>
            conn.query(
              sql`UPDATE ${raw(table)} SET userId = ${currentUser.id} WHERE userId = ${id}`,
            ),
          ),
        ]);

        await conn.query(sql`DELETE FROM user WHERE id = ${id}`);

        // TODO merge settings

        await conn.query(sql`UPDATE user SET
          email = COALESCE(email, ${email}),
          lat = COALESCE(lat, ${lat}),
          lon = COALESCE(lon, ${lon}),
          language = COALESCE(language, ${language}),
          createdAt = LEAST(createdAt, ${createdAt}),
          isAdmin = isAdmin OR ${isAdmin},
          sendGalleryEmails = sendGalleryEmails OR ${sendGalleryEmails},
          settings = COALESCE(settings, ${settings}),
          ${join(
            Object.entries(authData).map(
              ([column, value]) =>
                sql`${raw(column)} = COALESCE(${raw(column)}, ${value as RawValue})`,
            ),
          )}
          WHERE id = ${currentUser.id}
        `);
      } else {
        if (Object.keys(extraUserFields).length > 0) {
          await conn.query(sql`UPDATE user SET
            ${join(
              Object.entries(extraUserFields).map(
                ([column, value]) => sql`${raw(column)} = ${value as RawValue}`,
              ),
            )}
            WHERE id = ${userRow.id}
          `);
        }
      }
    } else {
      // no such user in DB for this auth provider

      const settings = ctx.request.body.settings || {};
      const lat = remoteLat ?? settings.lat ?? null;
      const lon = remoteLon ?? settings.lon ?? null;
      const email = remoteEmail || null;

      if (currentUser) {
        await conn.query(sql`UPDATE user SET
          email = COALESCE(email, ${email}),
          language = COALESCE(language, ${remoteLanguage}),
          lat = COALESCE(lat, ${lat}),
          lon = COALESCE(lon, ${lon}),
          ${join(
            Object.entries({
              [authProviderToColumn[authProvider]]: remoteUserId,
              ...extraUserFields,
            }).map(
              ([column, value]) => sql`${raw(column)} = ${value as RawValue}`,
            ),
          )}

          WHERE id = ${currentUser.id}
      `);
      } else {
        userId = (
          await conn.query(
            sql`INSERT INTO user SET ${join(
              Object.entries({
                name: remoteName,
                email,
                language: remoteLanguage,
                createdAt: now,
                lat: lat ?? null,
                lon: lon ?? null,
                sendGalleryEmails: true,
                isAdmin: false,
                settings: JSON.stringify(settings),
                [authProviderToColumn[authProvider]]: remoteUserId,
                ...extraUserFields,
              }).map(
                ([column, value]) => sql`${raw(column)} = ${value as RawValue}`,
              ),
            )}`,
          )
        ).insertId;
      }
    }

    if (currentUser) {
      authToken = currentUser.authToken;
    } else {
      authToken = randomBytes(32).toString('base64');

      await conn.query(
        sql`INSERT INTO auth SET userId = ${userId}, createdAt = ${now as any}, authToken = ${authToken}`,
      );
    }

    const [row] = await conn.query(
      sql`
        SELECT
          *,
          EXISTS (SELECT 1 FROM purchase WHERE DATEDIFF(NOW(), createdAt) <= 365 AND userId = id) AS isPremium
        FROM user
        WHERE id = ${userId}
      `,
    );

    userRow1 = row;

    await conn.commit();
  } catch (e) {
    await conn.rollback();

    throw e;
  } finally {
    await conn.release();
  }

  ctx.body = {
    user: userForResponse({ ...userRow1, authToken }),
    connect,
    clientData,
  };
}
