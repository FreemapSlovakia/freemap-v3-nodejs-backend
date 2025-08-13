import { Middleware } from 'koa';

export function acceptValidator(...type: string[]): Middleware {
  return async (ctx, next) => {
    if (!ctx.accepts(type)) {
      ctx.throw(406);
    }

    await next();
  };
}

export function contentTypeValidator(...type: string[]): Middleware {
  return async (ctx, next) => {
    if (!ctx.is(type)) {
      ctx.throw(415);
    }

    await next();
  };
}
