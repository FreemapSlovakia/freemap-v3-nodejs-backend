import Router from '@koa/router';
import { attachDeleteMapHandler } from './deleteMapHandler';
import { attachGetAllMapsHandler } from './getAllMapsHandler';
import { attachGetMapHandler } from './getMapHandler';
import { attachPostMapHandler } from './postMapHandler';
import { attachPatchMapHandler } from './patchMapHandler';

const router = new Router();

attachDeleteMapHandler(router);
attachGetAllMapsHandler(router);
attachGetMapHandler(router);
attachPostMapHandler(router);
attachPatchMapHandler(router);

export const mapsRouter = router;
