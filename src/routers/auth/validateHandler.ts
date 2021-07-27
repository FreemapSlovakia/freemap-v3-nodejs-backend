import Router from '@koa/router';
import { authenticator } from '../../authenticator';

export function attachValidateHandler(router: Router) {
  router.post('/validate', authenticator(true /*, true*/), async (ctx) => {
    const { rovasToken, ...user } = ctx.state.user;

    ctx.body = user;
  });
}
