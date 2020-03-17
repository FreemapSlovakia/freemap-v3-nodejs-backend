import Router from '@koa/router';
import { attachCreateTracklogHandler } from './createTracklogHandler';
import { attachGetTracklogHandler } from './getTracklogHandler';

const router = new Router();

attachCreateTracklogHandler(router);
attachGetTracklogHandler(router);

export const tracklogsRouter = router;
