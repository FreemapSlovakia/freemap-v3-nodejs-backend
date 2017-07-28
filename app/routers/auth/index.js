const Router = require('koa-router');

const attachLoginHandler = require('~/routers/auth/loginHandler');
const attachLogin2Handler = require('~/routers/auth/login2Handler');

const router = new Router();

attachLoginHandler(router);
attachLogin2Handler(router);

module.exports = router;
