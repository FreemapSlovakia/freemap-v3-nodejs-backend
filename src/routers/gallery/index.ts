import Router from '@koa/router';
import { attachGetPicturesHandler } from './getPicturesHandler';
import { attachGetPictureHandler } from './getPictureHandler';
import { attachGetPictureImageHandler } from './getPictureImageHandler';
import { attachPostPictureHandler } from './postPictureHandler';
import { attachGetAllTagsHandler } from './getAllTagsHandler';
import { attachDeletePictureHandler } from './deletePictureHandler';
import { attachPutPictureHandler } from './putPictureHandler';
import { attachPostPictureCommentHandler } from './postPictureCommentHandler';
import { attachPostPictureRatingHandler } from './postPictureRatingHandler';
import { attachGetAllPictureUsers } from './getAllUsersHandler';

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
