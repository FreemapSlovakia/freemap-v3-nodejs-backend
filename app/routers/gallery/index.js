const Router = require('koa-router');

const attachGetPicturesHandler = require('~/routers/gallery/getPicturesHandler');
const attachGetPictureHandler = require('~/routers/gallery/getPictureHandler');
const attachPostPictureHandler = require('~/routers/gallery/postPictureHandler');

const router = new Router();

attachGetPicturesHandler(router);
attachGetPictureHandler(router);
attachPostPictureHandler(router);

module.exports = router;
