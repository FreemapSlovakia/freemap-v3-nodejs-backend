import type { ServerResponse } from 'node:http';
import { inspect, types } from 'node:util';
import type { Middleware } from 'koa';
import { type Options, pinoHttp } from 'pino-http';
import { isClientError } from './clientError.js';

/**
 * pino-http as Koa middleware: a `request completed` line per request, and
 * `ctx.log`, a logger carrying the request id.
 *
 * Replaces koa-pino-logger, which logged every error thrown downstream at
 * error level — so each `ctx.throw(404, 'no such picture')` from a stale
 * gallery link landed among the real failures, and appeared twice besides,
 * since the `request completed` line already records the 404. A client error
 * (see {@link isClientError}) is logged at info here, as its message only: its
 * stack points at the `ctx.throw` and says nothing.
 *
 * Anything else is a server error. It is handed to pino-http as `res.err`, so
 * its one `request errored` line carries the real error — rather than this
 * logging it and pino-http then adding a second line with a made-up
 * "failed with status code 500". Unless that line is already written: a
 * client that hung up gets its `request aborted` line on the spot, so an error
 * thrown afterwards is logged here, or it would go unlogged.
 *
 * Either way the error is rethrown, for Koa to answer and Sentry to see (it
 * drops client errors itself, in `beforeSend`). Not covered, as before: an
 * error while Koa streams the body, after this has returned — Sentry has it.
 */
export function requestLogger(opts: Options): Middleware {
  const httpLogger = pinoHttp({
    customLogLevel: level,
    customErrorObject: withoutMadeUpError,
    ...opts,
  });

  return async (ctx, next) => {
    httpLogger(ctx.req, ctx.res);

    ctx.log = ctx.req.log;

    // 'close' comes last, after whichever event pino-http logged on — so once
    // it has fired, pino-http's line is written and `res.err` is read no more.
    // (`writableFinished` would not do: it turns true before 'finish' runs.)
    let closed = false;

    ctx.res.once('close', () => {
      closed = true;
    });

    try {
      await next();
    } catch (err) {
      if (isClientError(err)) {
        ctx.log.info({ status: err.status }, err.message);
      } else {
        // pino-http wants an Error. A thrown non-Error (`throw null`, a plain
        // object) is wrapped, its content kept; `isNativeError` also takes an
        // Error from another realm, which `instanceof` would wrap.
        const error = types.isNativeError(err)
          ? err
          : new Error(`non-error thrown: ${inspect(err)}`);

        if (closed) {
          ctx.log.error({ err: error }, 'request failed after it closed');
        } else {
          ctx.res.err = error;
        }
      }

      throw err;
    }
  };
}

/**
 * The completion line's level. pino-http's own default is info for every
 * line, a thrown server error included.
 */
function level(_req: unknown, res: ServerResponse, err?: Error) {
  if (err || res.err) {
    return 'error'; // thrown, or the connection failed
  }

  // A 5xx nothing threw: answered on purpose, e.g. the WMS proxy passing an
  // upstream's 502/503 on — a third party's outage, worth seeing, not ours.
  return res.statusCode >= 500 ? 'warn' : 'info';
}

/**
 * For a 5xx nothing threw, pino-http logs an Error it makes up on the spot —
 * "failed with status code 503", its stack inside pino-http. It says nothing
 * the status does not, so leave it out.
 */
function withoutMadeUpError(
  _req: unknown,
  res: ServerResponse,
  error: Error,
  val: Record<string, unknown>,
) {
  if (
    res.err ||
    error.message !== `failed with status code ${res.statusCode}`
  ) {
    return val;
  }

  const { err: _, ...rest } = val;

  return rest;
}
