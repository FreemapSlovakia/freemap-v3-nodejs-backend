import { RouterInstance } from '@koa/router';
import { authenticator, userForResponse } from '../../authenticator.js';

export function attachValidateHandler(router: RouterInstance) {
  router.post('/validate', authenticator(true), async (ctx) => {
    ctx.body = userForResponse(ctx.state.user!);
  });
}
