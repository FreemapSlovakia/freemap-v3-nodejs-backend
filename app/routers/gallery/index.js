const Router = require('koa-router');

const attachGetPicturesInRadiusHandler = require('~/routers/gallery/getPicturesInRadiusHandler');
const attachGetPictureHandler = require('~/routers/gallery/getPictureHandler');

const router = new Router();

attachGetPicturesInRadiusHandler(router);
attachGetPictureHandler(router);

module.exports = router;
