const Router = require('koa-router');

const attachGetPicturesHandler = require('~/routers/gallery/getPicturesHandler');
const attachGetPictureHandler = require('~/routers/gallery/getPictureHandler');
const attachGetPictureImageHandler = require('~/routers/gallery/getPictureImageHandler');
const attachPostPictureHandler = require('~/routers/gallery/postPictureHandler');
const attachGetAllTagsHandler = require('~/routers/gallery/getAllTagsHandler');
const attachDeletePictureHandler = require('~/routers/gallery/deletePictureHandler');
const attachPutPictureHandler = require('~/routers/gallery/putPictureHandler');
const attachPostPictureCommentHandler = require('~/routers/gallery/postPictureCommentHandler');
const attachPostPictureRatingHandler = require('~/routers/gallery/postPictureRatingHandler');
const attachGetAllPictureUsers = require('~/routers/gallery/getAllUsersHandler');

const router = new Router();

attachGetPicturesHandler(router);
attachGetPictureHandler(router);
attachGetPictureImageHandler(router);
attachPostPictureHandler(router);
attachGetAllTagsHandler(router);
attachDeletePictureHandler(router);
attachPutPictureHandler(router);
attachPostPictureCommentHandler(router);
attachPostPictureRatingHandler(router);
attachGetAllPictureUsers(router);

module.exports = router;
