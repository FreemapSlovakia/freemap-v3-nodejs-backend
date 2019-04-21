const Router = require('koa-router');

const router = new Router();

require('./deleteTokenHandler')(router);
require('./getAllTokensHandler')(router);
require('./getTokenHandler')(router);
require('./postTokenHandler')(router);
require('./putTokenHandler')(router);

module.exports = router;
