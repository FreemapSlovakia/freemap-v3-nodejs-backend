const config = require('config');
const { OAuth2Client } = require('google-auth-library');

const clientId = config.get('google.clientId');
const clientSecret = config.get('google.clientSecret');

module.exports = new OAuth2Client(clientId, clientSecret, '');
