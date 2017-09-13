const { promisify } = require('util');
const config = require('config');
const GoogleAuth = require('google-auth-library');

const auth = new GoogleAuth();
const clientId = config.get('google.clientId');
const clientSecret = config.get('google.clientSecret');

const client = new auth.OAuth2(clientId, clientSecret, '');

module.exports = {
  verifyIdToken: promisify(client.verifyIdToken.bind(client)),
  clientId,
};
