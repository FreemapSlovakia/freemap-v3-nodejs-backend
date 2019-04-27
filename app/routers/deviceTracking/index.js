const Router = require('koa-router');

const router = new Router();

require('./deleteDeviceHandler')(router);
require('./getAllDevicesHandler')(router);
require('./getDeviceHandler')(router);
require('./postDeviceHandler')(router);
require('./putDeviceHandler')(router);
require('./trackDeviceHandler')(router);

require('./deleteTokenHandler')(router);
require('./getAllTokensHandler')(router);
require('./getPublicTokensHandler')(router);
require('./getTokenHandler')(router);
require('./postTokenHandler')(router);
require('./putTokenHandler')(router);

module.exports = router;
