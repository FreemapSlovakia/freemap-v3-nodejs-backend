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
