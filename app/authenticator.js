const rp = require('request-promise-native');
const config = require('config');
const fb = require('~/fb');
const client = require('~/google');

const consumerKey = config.get('oauth.consumerKey');
const consumerSecret = config.get('oauth.consumerSecret');

module.exports = function authenticator(require, deep) {
  return async function authorize(ctx, next) {
    let { authToken } = ctx.query; // used in websockets

    if (!authToken) {
      const ah = ctx.get('Authorization');
      const m = /^bearer (.+)$/i.exec(ah || '');
      if (!m) {
        if (require) {
          ctx.status = 401;
          ctx.set(
            'WWW-Authenticate',
            'Bearer realm="freemap"; error="missing token"'
          );
        } else {
          await next();
        }
        return;
      }

      authToken = m[1];
    }

    const [auth] = await ctx.state.db.query(
      `SELECT userId, osmAuthToken, osmAuthTokenSecret, facebookAccessToken, googleIdToken, name, email, isAdmin, lat, lon, settings, preventTips
        FROM auth INNER JOIN user ON (userId = id) WHERE authToken = ?`,
      [authToken]
    );

    if (!auth) {
      await bad('');
      return;
    }

    const user = {
      id: auth.userId,
      isAdmin: !!auth.isAdmin,
      name: auth.name,
      authToken,
      lat: auth.lat,
      lon: auth.lon,
      email: auth.email,
      settings: JSON.parse(auth.settings),
      preventTips: !!auth.preventTips
    };

    if (!deep) {
      ctx.state.user = user;
      await next();
    } else if (auth.googleIdToken) {
      try {
        await client.verifyIdToken({ idToken: auth.googleIdToken });
      } catch (e) {
        await bad('Google');
        return;
      }

      ctx.state.user = user;
      await next();
    } else if (auth.facebookAccessToken) {
      try {
        await fb
          .withAccessToken(auth.facebookAccessToken)
          .api('/me', { fields: 'id' });
      } catch (e) {
        await bad('Facebook');
        return;
      }

      ctx.state.user = user;
      await next();
    } else if (auth.osmAuthToken) {
      try {
        await rp.get({
          url: 'https://api.openstreetmap.org/api/0.6/user/details',
          oauth: {
            consumer_key: consumerKey,
            consumer_secret: consumerSecret,
            token: auth.osmAuthToken,
            token_secret: auth.osmAuthTokenSecret
          }
        });
      } catch (e) {
        if (e.name === 'StatusCodeError' && e.statusCode === 401) {
          await bad('OSM');
          return;
        }
      }

      ctx.state.user = user;
      await next();
    }

    async function bad(what) {
      await ctx.state.db.query('DELETE FROM auth WHERE authToken = ?', [
        authToken
      ]);

      if (require) {
        ctx.status = 401;
        ctx.set(
          'WWW-Authenticate',
          `Bearer realm="freemap"; error="invalid ${what} authorization"`
        );
      } else {
        await next();
      }
    }
  };
};
