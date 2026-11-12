/**
 * Whether a thrown value is a client error: one `ctx.throw` (http-errors)
 * made with a 4xx status, which it marks `expose` — safe to show the client,
 * since the client caused it. Expected, so it is logged at info and kept out
 * of Sentry.
 *
 * Deliberately not "anything with a 4xx `status`": an upstream failure can
 * carry one too — an `OsmHttpError(403)` or `(429)` is a credential or rate
 * problem on our side — and would then be filed as the client's fault, at
 * info with no stack and invisible to Sentry.
 */
export function isClientError(
  err: unknown,
): err is { status: number; message: string; expose: true } {
  if (!err || typeof err !== 'object') {
    return false;
  }

  const { expose, status } = err as { expose?: unknown; status?: unknown };

  return (
    expose === true &&
    typeof status === 'number' &&
    status >= 400 &&
    status < 500
  );
}

// A write to a connection the client has closed: Koa's body pipeline reports
// a premature close, a write to the dead socket fails with EPIPE (the
// GET /events reports in Sentry). Not ECONNRESET: none seen yet — add it if
// it shows up.
const HANG_UP_CODES = new Set(['ERR_STREAM_PREMATURE_CLOSE', 'EPIPE']);

/**
 * Whether a thrown value is what a client hanging up leaves behind. Only
 * meaningful with Koa's `headerSent`: the response had started, or could no
 * longer be written.
 *
 * The code alone cannot tell the client's socket from an upstream one, so an
 * upstream EPIPE would pass too — but only after headers are out, and no
 * handler here writes its response before its upstream call is done (the WMS
 * proxy buffers the upstream body; SSE streams our own data). If the client
 * left first, nobody waits on that request, and an upstream really down fails
 * the requests still open too, which do reach Sentry.
 */
export function isHangUp(err: unknown): boolean {
  if (!err || typeof err !== 'object') {
    return false;
  }

  const { code } = err as { code?: unknown };

  return typeof code === 'string' && HANG_UP_CODES.has(code);
}
