import Router from '@koa/router';

import { attachLoginHandler } from './loginHandler';
import { attachLogin2Handler } from './login2Handler';
import { attachLogoutHandler } from './logoutHandler';
import { attachValidateHandler } from './validateHandler';
import { attachLoginWithFacebookHandler } from './loginWithFacebookHandler';
import { attachLoginWithGoogleHandler } from './loginWithGoogleHandler';
import { attachPatchUserHandler } from './patchUserHandler';

const router = new Router();

attachLoginHandler(router);
attachLogin2Handler(router);
attachLogoutHandler(router);
attachValidateHandler(router);
attachLoginWithFacebookHandler(router);
attachLoginWithGoogleHandler(router);
attachPatchUserHandler(router);

export const authRouter = router;
