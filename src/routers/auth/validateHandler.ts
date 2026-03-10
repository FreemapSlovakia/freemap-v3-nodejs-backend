import { RouterInstance } from '@koa/router';
import { authenticator, userForResponse } from '../../authenticator.js';
import { registerPath } from '../../openapi.js';
import { UserResponseSchema } from '../../types.js';

export function attachValidateHandler(router: RouterInstance) {
  registerPath('/auth/validate', {
    post: {
      responses: {
        200: {
          content: { 'application/json': { schema: UserResponseSchema } },
        },
        401: {},
      },
    },
  });

  router.post('/validate', authenticator(true), async (ctx) => {
    ctx.body = UserResponseSchema.parse(userForResponse(ctx.state.user!));
  });
}
