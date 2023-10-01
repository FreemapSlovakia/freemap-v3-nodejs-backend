import Router from '@koa/router';

import { attachLoginWithOsmHandler } from './loginWithOsmHandler';
import { attachLogoutHandler } from './logoutHandler';
import { attachValidateHandler } from './validateHandler';
import { attachLoginWithFacebookHandler } from './loginWithFacebookHandler';
import { attachLoginWithGoogleHandler } from './loginWithGoogleHandler';
import { attachPatchUserHandler } from './patchUserHandler';
import { attachRovasTokenHandler } from './rovasTokenHandler';
import { attachRovasValidateHandler } from './rovasValidateHandler';
import { attachDeleteUserHandler } from './deleteUserHandler';

const router = new Router();

attachLoginWithOsmHandler(router);
attachLogoutHandler(router);
attachValidateHandler(router);
attachLoginWithFacebookHandler(router);
attachLoginWithGoogleHandler(router);
attachPatchUserHandler(router);
attachRovasTokenHandler(router);
attachRovasValidateHandler(router);
attachDeleteUserHandler(router);

export const authRouter = router;
