import Router from '@koa/router';
import { authenticator, userForResponse } from '../../authenticator.js';

export function attachValidateHandler(router: Router) {
  router.post('/validate', authenticator(true), async (ctx) => {
    const { rovasToken, ...user } = ctx.state.user;

    ctx.body = userForResponse(ctx.state.user);
  });
}
