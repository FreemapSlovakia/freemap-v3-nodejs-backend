const rp = require('request-promise-native');
const config = require('config');
const { parseString } = require('xml2js');
const { promisify } = require('util');

const parseStringAsync = promisify(parseString);

const consumerKey = config.get('oauth.consumerKey');
const consumerSecret = config.get('oauth.consumerSecret');

module.exports = function authenticator(require, osm) {
  return async function authorize(ctx, next) {
    const ah = ctx.get('Authorization');

    const m = /^bearer (.+)$/i.exec(ah || '');
    if (!m) {
      if (require) {
        ctx.status = 401;
        ctx.set('WWW-Authenticate', 'Bearer realm="freemap"; error="missing token"');
      } else {
        await next();
      }
      return;
    }

    const authToken = m[1];
    const auths = await ctx.state.db.query('SELECT userId, osmAuthToken, osmAuthTokenSecret FROM auth WHERE authToken = ?', [authToken]);

    let userDetails;
    if (auths.length) {
      if (osm) {
        try {
          userDetails = await rp.get({
            url: 'http://api.openstreetmap.org/api/0.6/user/details',
            oauth: {
              consumer_key: consumerKey,
              consumer_secret: consumerSecret,
              token: auths[0].osmAuthToken,
              token_secret: auths[0].osmAuthTokenSecret,
            },
          });
        } catch (e) {
          if (e.name === 'StatusCodeError' && e.statusCode === 401) {
            // TODO delete authToken from DB

            if (require) {
              ctx.status = 401;
              ctx.set('WWW-Authenticate', 'Bearer realm="freemap"; error="invalid OSM authorization"');
            } else {
              await next();
            }
            return;
          }
        }

        const result = await parseStringAsync(userDetails);
        const { $: { display_name: name /* , id: osmId */ }, home: [{ $: { lat, lon } }] } = result.osm.user[0];
        ctx.state.user = { id: auths[0].userId, name, lat, lon, authToken };
        await next();
      } else {
        ctx.state.user = { id: auths[0].userId, authToken };
        await next();
      }
    } else if (require) {
      ctx.status = 401;
      ctx.set('WWW-Authenticate', 'Bearer realm="freemap"; error="invalid token"');
    } else {
      next();
    }
  };
};