import Router from '@koa/router';
import { attachDeleteDeviceHandler } from './deleteDeviceHandler.js';
import { attachDeleteTokenHandler } from './deleteTokenHandler.js';
import { attachGetAllDevicesHandler } from './getAllDevicesHandler.js';
import { attachGetAllTokensHandler } from './getAllTokensHandler.js';
import { attachGetDeviceHandler } from './getDeviceHandler.js';
import { attachGetPublicTokensHandler } from './getPublicTokensHandler.js';
import { attachGetTokenHandler } from './getTokenHandler.js';
import { attachPostDeviceHandler } from './postDeviceHandler.js';
import { attachPostTokenHandler } from './postTokenHandler.js';
import { attachPutDeviceHandler } from './putDeviceHandler.js';
import { attachPutTokenHandler } from './putTokenHandler.js';
import { attachTrackDeviceJsonHandler } from './trackDeviceHandlerJson.js';
import { attachTrackDeviceTraccarHandler } from './trackDeviceHandlerTraccar.js';
import { attachTrackDeviceUrlEncodedHandler } from './trackDeviceHandlerUrlEncoded.js';

const router = new Router();

attachDeleteDeviceHandler(router);
attachGetAllDevicesHandler(router);
attachGetDeviceHandler(router);
attachPostDeviceHandler(router);
attachPutDeviceHandler(router);
attachTrackDeviceJsonHandler(router);
attachTrackDeviceUrlEncodedHandler(router);
attachTrackDeviceTraccarHandler(router);
attachDeleteTokenHandler(router);
attachGetAllTokensHandler(router);
attachGetPublicTokensHandler(router);
attachGetTokenHandler(router);
attachPostTokenHandler(router);
attachPutTokenHandler(router);

export const trackingRouter = router;
