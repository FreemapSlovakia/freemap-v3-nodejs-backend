const Router = require('koa-router');

const attachLoginHandler = require('~/routers/auth/loginHandler');
const attachLogin2Handler = require('~/routers/auth/login2Handler');
const attachLogoutHandler = require('~/routers/auth/logoutHandler');
const attachValidateHandler = require('~/routers/auth/validateHandler');
const attachLoginWithFacebookHandler = require('~/routers/auth/loginWithFacebookHandler');
const attachLoginWithGoogleHandler = require('~/routers/auth/loginWithGoogleHandler');
const attachPatchUserHandler = require('~/routers/auth/patchUserHandler');

const router = new Router();

attachLoginHandler(router);
attachLogin2Handler(router);
attachLogoutHandler(router);
attachValidateHandler(router);
attachLoginWithFacebookHandler(router);
attachLoginWithGoogleHandler(router);
attachPatchUserHandler(router);

module.exports = router;
