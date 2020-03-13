const SQL = require('sql-template-strings');
const uuidBase62 = require('uuid-base62');

module.exports = async function login(
  db,
  ctx,
  dbField,
  dbValue,
  authFields,
  authValues,
  name0,
  email0,
  lat0,
  lon0,
) {
  const [user] = await db.query(
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
      await db.query(
        SQL`INSERT INTO user SET `.append(dbField).append(SQL` = ${dbValue},
          name = ${name},
          email = ${email},
          createdAt = ${now},
          lat = ${lat},
          lon = ${lon},
          settings = ${JSON.stringify(settings)}`),
      )
    ).insertId;
  }

  const authToken = uuidBase62.v4(); // TODO rather some crypro securerandom

  await db.query(
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
};
