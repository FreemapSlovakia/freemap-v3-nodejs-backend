import Router from '@koa/router';
import { attachDeleteMapHandler } from './deleteMapHandler.js';
import { attachGetAllMapsHandler } from './getAllMapsHandler.js';
import { attachGetMapHandler } from './getMapHandler.js';
import { attachPatchMapHandler } from './patchMapHandler.js';
import { attachPostMapHandler } from './postMapHandler.js';
import { attachPutMapTagsHandler } from './putMapTagsHandler.js';

const router = new Router();

attachDeleteMapHandler(router);
attachGetAllMapsHandler(router);
attachGetMapHandler(router);
attachPostMapHandler(router);
attachPatchMapHandler(router);
attachPutMapTagsHandler(router);

export const mapsRouter = router;
