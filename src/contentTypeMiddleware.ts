import { Middleware } from '@koa/router';

export function contentTypeMiddleware(
  map: Record<string, Middleware[]>,
): Middleware {
  return async (ctx, next) => {
    const type = ctx.request.headers['content-type']?.split(';')[0].trim();

    const chain = map[type ?? ''];

    if (!chain) {
      ctx.throw(415, 'Unsupported Media Type');

      return;
    }

    let index = 0;

    const run = async (): Promise<void> => {
      const mw = chain[index++];

      if (mw) {
        await mw(ctx, run);
      } else {
        await next();
      }
    };

    await run();
  };
}
