import Router from '@koa/router';

import { attachDeleteUserHandler } from './deleteUserHandler.js';
import { attachDisconnectHandler } from './disconnectHandler.js';
import { attachLoginWithFacebookHandler } from './loginWithFacebookHandler.js';
import { attachLoginWithGarmin2Handler } from './loginWithGarmin2Handler.js';
import { attachLoginWithGarminHandler } from './loginWithGarminHandler.js';
import { attachLoginWithGoogleHandler } from './loginWithGoogleHandler.js';
import { attachLoginWithOsmHandler } from './loginWithOsmHandler.js';
import { attachLogoutHandler } from './logoutHandler.js';
import { attachPatchUserHandler } from './patchUserHandler.js';
import { attachRovasTokenHandler } from './rovasTokenHandler.js';
import { attachRovasValidateHandler } from './rovasValidateHandler.js';
import { attachValidateHandler } from './validateHandler.js';

const router = new Router();

attachLoginWithOsmHandler(router);
attachLogoutHandler(router);
attachValidateHandler(router);
attachLoginWithFacebookHandler(router);
attachLoginWithGoogleHandler(router);
attachLoginWithGarminHandler(router);
attachLoginWithGarmin2Handler(router);
attachPatchUserHandler(router);
attachRovasTokenHandler(router);
attachRovasValidateHandler(router);
attachDeleteUserHandler(router);
attachDisconnectHandler(router);

export const authRouter = router;
