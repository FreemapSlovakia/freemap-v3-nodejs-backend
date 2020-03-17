import Router from '@koa/router';

import { attachDeleteDeviceHandler } from './deleteDeviceHandler';
import { attachGetAllDevicesHandler } from './getAllDevicesHandler';
import { attachGetDeviceHandler } from './getDeviceHandler';
import { attachPostDeviceHandler } from './postDeviceHandler';
import { attachPutDeviceHandler } from './putDeviceHandler';
import { attachTrackDeviceHandler } from './trackDeviceHandler';
import { attachDeleteTokenHandler } from './deleteTokenHandler';
import { attachGetAllTokensHandler } from './getAllTokensHandler';
import { attachGetPublicTokensHandler } from './getPublicTokensHandler';
import { attachGetTokenHandler } from './getTokenHandler';
import { attachPostTokenHandler } from './postTokenHandler';
import { attachPutTokenHandler } from './putTokenHandler';

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
