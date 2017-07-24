const request = require('request');
const qs = require('querystring');
const config = require('config');

const consumerKey = config.get('oauth.consumerKey');
const consumerSecret = config.get('oauth.consumerSecret');

const checkRequestMiddleware = rootRequire('checkRequestMiddleware');
const logger = rootRequire('logger');

module.exports = function attachLogin2Handler(router) {
  router.all(
    '/login2',
    checkRequestMiddleware({ method: 'POST', acceptsJson: true }), // TODO schema
    (req, res) => {
      request.post(
        {
          url: 'http://www.openstreetmap.org/oauth/access_token',
          oauth: {
            consumer_key: consumerKey,
            consumer_secret: consumerSecret,
            token: req.body.token,
            token_secret: global.oauth_token_secret, // TODO read from session
            verifier: req.body.verifier,
          },
        },
        (err, _, body) => {
          if (err) {
            logger.error({ err }, 'Error fetching request token.');
            res.status(500).end();
          } else {
            const permData = qs.parse(body);
            next(res, permData);
          }
        },
      );
    },
  );
};

function next(res, permData) {
  request.get(
    {
      url: 'http://api.openstreetmap.org/api/0.6/user/details',
      oauth: {
        consumer_key: consumerKey,
        consumer_secret: consumerSecret,
        token: permData.oauth_token,
        token_secret: permData.oauth_token_secret,
      },
    },
    (err, _, body) => {
      if (err) {
        logger.error({ err }, 'Error fetching request token.');
        res.status(500).end();
      } else {
        res.json(body); // TODO pase XML, store to DB, ...
      }
    },
  );
}
