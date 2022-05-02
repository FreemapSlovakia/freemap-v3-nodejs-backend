import Router from '@koa/router';

import { attachLoginHandler } from './loginHandler';
import { attachLogin2Handler } from './login2Handler';
import { attachLogoutHandler } from './logoutHandler';
import { attachValidateHandler } from './validateHandler';
import { attachLoginWithFacebookHandler } from './loginWithFacebookHandler';
import { attachLoginWithGoogleHandler } from './loginWithGoogleHandler';
import { attachPatchUserHandler } from './patchUserHandler';
import { attachRovasTokenHandler } from './rovasTokenHandler';
import { attachRovasValidateHandler } from './rovasValidateHandler';
import { attachDeleteUserHandler } from './deleteUserHandler';

const router = new Router();

attachLoginHandler(router);
attachLogin2Handler(router);
attachLogoutHandler(router);
attachValidateHandler(router);
attachLoginWithFacebookHandler(router);
attachLoginWithGoogleHandler(router);
attachPatchUserHandler(router);
attachRovasTokenHandler(router);
attachRovasValidateHandler(router);
attachDeleteUserHandler(router);

export const authRouter = router;
