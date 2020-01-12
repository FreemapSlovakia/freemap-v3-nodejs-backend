const Router = require('koa-router');

const router = new Router();

require('./deleteMapHandler')(router);
require('./getAllMapsHandler')(router);
require('./getMapHandler')(router);
require('./postMapHandler')(router);
require('./patchMapHandler')(router);

module.exports = router;
