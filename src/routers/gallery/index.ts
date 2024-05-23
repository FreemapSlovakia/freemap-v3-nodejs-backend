import Router from '@koa/router';
import { attachGetPicturesHandler } from './getPicturesHandler.js';
import { attachGetPictureHandler } from './getPictureHandler.js';
import { attachGetPictureImageHandler } from './getPictureImageHandler.js';
import { attachPostPictureHandler } from './postPictureHandler.js';
import { attachGetAllTagsHandler } from './getAllTagsHandler.js';
import { attachDeletePictureHandler } from './deletePictureHandler.js';
import { attachPutPictureHandler } from './putPictureHandler.js';
import { attachPostPictureCommentHandler } from './postPictureCommentHandler.js';
import { attachPostPictureRatingHandler } from './postPictureRatingHandler.js';
import { attachGetAllPictureUsers } from './getAllUsersHandler.js';

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
