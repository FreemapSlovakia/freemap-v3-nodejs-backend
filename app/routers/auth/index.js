const Router = require('koa-router');

const attachLoginHandler = require('~/routers/auth/loginHandler');
const attachLogin2Handler = require('~/routers/auth/login2Handler');
const attachLogoutHandler = require('~/routers/auth/logoutHandler');
const attachValidateHandler = require('~/routers/auth/validateHandler');

const router = new Router();

attachLoginHandler(router);
attachLogin2Handler(router);
attachLogoutHandler(router);
attachValidateHandler(router);

module.exports = router;
