const rp = require('request-promise-native');
const config = require('config');
const { parseString } = require('xml2js');
const { promisify } = require('util');
const fb = require('~/fb');

const parseStringAsync = promisify(parseString);

const consumerKey = config.get('oauth.consumerKey');
const consumerSecret = config.get('oauth.consumerSecret');

module.exports = function authenticator(require, deep) {
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
    const auths = await ctx.state.db.query(`SELECT userId, osmAuthToken, osmAuthTokenSecret, facebookAccessToken, name, isAdmin
      FROM auth INNER JOIN user ON (userId = id) WHERE authToken = ?`, [authToken]);

    let userDetails;
    if (auths.length) {
      const [auth] = auths;
      if (!deep) {
        ctx.state.user = { id: auth.userId, isAdmin: !!auth.isAdmin, name: auth.name, authToken };
        await next();
      } else if (auth.facebookAccessToken) {
        try {
          console.log('XXXXXXXXXXXX', auth.facebookAccessToken);
          await fb.withAccessToken(auth.facebookAccessToken).api('/me', { fields: 'id' });
        } catch (e) {
          console.log('EEEEEEEEE', e);
          if (require) {
            ctx.status = 401;
            ctx.set('WWW-Authenticate', 'Bearer realm="freemap"; error="invalid Facebook authorization"');
          } else {
            await next();
          }
          return;
        }

        ctx.state.user = { id: auth.userId, isAdmin: !!auth.isAdmin, name: auth.name, authToken };
        await next();
      } else if (auth.osmAuthToken) {
        try {
          userDetails = await rp.get({
            url: 'http://api.openstreetmap.org/api/0.6/user/details',
            oauth: {
              consumer_key: consumerKey,
              consumer_secret: consumerSecret,
              token: auth.osmAuthToken,
              token_secret: auth.osmAuthTokenSecret,
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

        const { /* $: { display_name: name, id: osmId }, */ home } = result.osm.user[0];
        const { lat, lon } = home && home.length && home[0].$ || {};

        // TODO update name in DB

        ctx.state.user = { id: auth.userId, isAdmin: !!auth.isAdmin, name: auth.name, authToken, lat, lon };
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
