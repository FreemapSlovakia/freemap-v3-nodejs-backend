import { ParameterizedContext } from 'koa';
import { pool } from '../../database';
import { SQL } from 'sql-template-strings';
import { randomBytes } from 'crypto';

export async function login(
  ctx: ParameterizedContext,
  dbField: string,
  dbValue: string,
  authFields: string,
  authValues: string[],
  name0: string,
  email0: string,
  lat0: number,
  lon0: number,
) {
  const [user] = await pool.query(
    SQL`SELECT id, name, email, isAdmin, lat, lon, settings FROM user WHERE `
      .append(dbField)
      .append(SQL` = ${dbValue}`),
  );

  const now = new Date();

  let userId;
  let name;
  let email;
  let isAdmin;
  let lat;
  let lon;
  let settings;
  let preventTips;

  if (user) {
    ({ name, email, lat, lon } = user);
    settings = JSON.parse(user.settings);
    userId = user.id;
    isAdmin = !!user.isAdmin;
    preventTips = !!user.preventTips;
  } else {
    settings = ctx.request.body.settings || {};
    lat = lat0 || settings.lat;
    lon = lon0 || settings.lon;
    name = name0;
    email = email0;
    isAdmin = false;
    preventTips = false;

    userId = (
      await pool.query(
        SQL`INSERT INTO user SET `.append(dbField).append(SQL` = ${dbValue},
          name = ${name},
          email = ${email},
          createdAt = ${now},
          lat = ${lat ?? null},
          lon = ${lon ?? null},
          settings = ${JSON.stringify(settings) ?? null}`),
      )
    ).insertId;
  }

  const authToken = randomBytes(32).toString('base64');

  await pool.query(
    `INSERT INTO auth (userId, createdAt, authToken, ${authFields}) VALUES (?, ?, ?,${authFields
      .split(',')
      .map(() => '?')
      .join(',')})`,
    [userId, now, authToken, ...authValues],
  );

  ctx.body = {
    id: userId,
    authToken,
    name,
    email,
    isAdmin,
    lat,
    lon,
    settings,
    preventTips,
  };
}
