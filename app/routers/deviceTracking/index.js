const Router = require('koa-router');

const router = new Router();

require('./deleteDeviceHandler')(router);
require('./getAllDevicesHandler')(router);
require('./getDeviceHandler')(router);
require('./postDeviceHandler')(router);
require('./putDeviceHandler')(router);

module.exports = router;
