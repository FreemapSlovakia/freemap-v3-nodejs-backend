const Router = require('koa-router');

const attachGetPicturesHandler = require('~/routers/gallery/getPicturesHandler');
const attachGetPictureHandler = require('~/routers/gallery/getPictureHandler');
const attachPostPictureHandler = require('~/routers/gallery/postPictureHandler');
const attachGetAllTagsHandler = require('~/routers/gallery/getAllTagsHandler');
const attachDeletePictureHandler = require('~/routers/gallery/deletePictureHandler');
const attachPutPictureHandler = require('~/routers/gallery/putPictureHandler');
const attachPostPictureCommentHandler = require('~/routers/gallery/postPictureCommentHandler');
const attachPostPictureRatingHandler = require('~/routers/gallery/postPictureRatingHandler');

const router = new Router();

attachGetPicturesHandler(router);
attachGetPictureHandler(router);
attachPostPictureHandler(router);
attachGetAllTagsHandler(router);
attachDeletePictureHandler(router);
attachPutPictureHandler(router);
attachPostPictureCommentHandler(router);
attachPostPictureRatingHandler(router);

module.exports = router;
