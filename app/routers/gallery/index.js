const Router = require('koa-router');

const attachGetPicturesHandler = require('~/routers/gallery/getPicturesHandler');
const attachGetPictureHandler = require('~/routers/gallery/getPictureHandler');

const router = new Router();

attachGetPicturesHandler(router);
attachGetPictureHandler(router);

module.exports = router;
