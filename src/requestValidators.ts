import { Middleware } from 'koa';

export function acceptValidator(...type: string[]): Middleware {
  return async (ctx, next) => {
    if (!ctx.accepts(type)) {
      ctx.throw(406);
    }

    await next();
  };
}
