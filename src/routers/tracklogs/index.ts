import Router from '@koa/router';
import { attachCreateTracklogHandler } from './createTracklogHandler.js';
import { attachGetTracklogHandler } from './getTracklogHandler.js';

const router = new Router();

attachCreateTracklogHandler(router);
attachGetTracklogHandler(router);

export const tracklogsRouter = router;
