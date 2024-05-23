import Router from '@koa/router';

import { attachDeleteDeviceHandler } from './deleteDeviceHandler.js';
import { attachGetAllDevicesHandler } from './getAllDevicesHandler.js';
import { attachGetDeviceHandler } from './getDeviceHandler.js';
import { attachPostDeviceHandler } from './postDeviceHandler.js';
import { attachPutDeviceHandler } from './putDeviceHandler.js';
import { attachTrackDeviceHandler } from './trackDeviceHandler.js';
import { attachDeleteTokenHandler } from './deleteTokenHandler.js';
import { attachGetAllTokensHandler } from './getAllTokensHandler.js';
import { attachGetPublicTokensHandler } from './getPublicTokensHandler.js';
import { attachGetTokenHandler } from './getTokenHandler.js';
import { attachPostTokenHandler } from './postTokenHandler.js';
import { attachPutTokenHandler } from './putTokenHandler.js';

const router = new Router();

attachDeleteDeviceHandler(router);
attachGetAllDevicesHandler(router);
attachGetDeviceHandler(router);
attachPostDeviceHandler(router);
attachPutDeviceHandler(router);
attachTrackDeviceHandler(router);
attachDeleteTokenHandler(router);
attachGetAllTokensHandler(router);
attachGetPublicTokensHandler(router);
attachGetTokenHandler(router);
attachPostTokenHandler(router);
attachPutTokenHandler(router);

export const trackingRouter = router;
