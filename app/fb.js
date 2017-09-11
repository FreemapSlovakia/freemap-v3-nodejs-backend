const { Facebook } = require('fb');
const config = require('config');

module.exports = new Facebook({ appSecret: config.get('facebook.appSecret') });
