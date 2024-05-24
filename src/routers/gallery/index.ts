import Router from '@koa/router';
import { attachDeletePictureHandler } from './deletePictureHandler.js';
import { attachGetAllTagsHandler } from './getAllTagsHandler.js';
import { attachGetAllPictureUsers } from './getAllUsersHandler.js';
import { attachGetPictureHandler } from './getPictureHandler.js';
import { attachGetPictureImageHandler } from './getPictureImageHandler.js';
import { attachGetPicturesHandler } from './getPicturesHandler.js';
import { attachPostPictureCommentHandler } from './postPictureCommentHandler.js';
import { attachPostPictureHandler } from './postPictureHandler.js';
import { attachPostPictureRatingHandler } from './postPictureRatingHandler.js';
import { attachPutPictureHandler } from './putPictureHandler.js';

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

export const galleryRouter = router;
