import { RouterInstance } from '@koa/router';
import { authenticator, userForResponse } from '../../authenticator.js';
import { AUTH_REQUIRED, registerPath } from '../../openapi.js';
import { UserResponseSchema } from '../../types.js';

export function attachValidateHandler(router: RouterInstance) {
  registerPath('/auth/validate', {
    post: {
      summary: 'Validate the current auth token and return user info',
      tags: ['auth'],
      security: AUTH_REQUIRED,
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
