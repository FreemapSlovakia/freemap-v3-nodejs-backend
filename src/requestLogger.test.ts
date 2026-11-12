import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import test from 'node:test';
import Koa from 'koa';
import { pino } from 'pino';
import { isClientError, isHangUp } from './clientError.js';
import { requestLogger } from './requestLogger.js';

type Line = { level: number; msg: string; err?: { message: string } };

// The line that ends a request's logging, whichever way it ended.
const LAST =
  /^request (completed|errored|aborted)$|^request failed after it closed$/;

/**
 * GET / from an app whose handler is `handle`, and return the log lines once
 * the request's last one is in. With `hangUpAfter`, the client gives up after
 * that many ms, and the lines are awaited until the handler has failed too.
 */
async function logsFor(
  handle: (ctx: Koa.Context) => unknown,
  {
    hangUpAfter,
    lastLines = 1,
  }: { hangUpAfter?: number; lastLines?: number } = {},
) {
  const lines: Line[] = [];

  let notify = () => {
    // replaced once the wait for the last line is set up
  };

  const stream = new Writable({
    write(chunk, _enc, done) {
      lines.push(JSON.parse(String(chunk)));

      notify();

      done();
    },
  });

  const app = new Koa();

  app.silent = true; // Koa's own stderr report is not under test

  // Koa leaves a thrown null unanswered (its onerror ignores a null error),
  // so answer that one here, to see what requestLogger made of it
  app.use(async (ctx, next) => {
    try {
      await next();
    } catch (err) {
      if (err !== null) {
        throw err;
      }

      ctx.status = 500;

      ctx.body = 'null';
    }
  });

  app.use(requestLogger({ logger: pino(stream) }));

  app.use(async (ctx) => {
    await handle(ctx);
  });

  const server = app.listen(0, '127.0.0.1');

  await new Promise((resolve) => server.once('listening', resolve));

  let timer: NodeJS.Timeout | undefined;

  const done = new Promise<void>((resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`no last line in ${JSON.stringify(lines)}`)),
      5000,
    );

    notify = () => {
      if (lines.filter((line) => LAST.test(line.msg)).length >= lastLines) {
        clearTimeout(timer);

        resolve();
      }
    };
  });

  // awaited only once fetch is through; until then a rejection is not
  // unhandled, and the timer is cleared below whichever way this ends
  done.catch(() => undefined);

  try {
    const { port } = server.address() as AddressInfo;

    let status = 0;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, {
        signal:
          hangUpAfter === undefined
            ? undefined
            : AbortSignal.timeout(hangUpAfter),
      });

      status = res.status;

      await res.arrayBuffer();
    } catch (err) {
      if (hangUpAfter === undefined) {
        throw err;
      }
    }

    await done;

    return { status, lines };
  } finally {
    clearTimeout(timer);

    // fetch keeps the connection alive, which close() alone would wait out
    server.closeAllConnections();

    server.close();
  }
}

const errors = (lines: Line[]) => lines.filter((line) => line.level >= 50);

test('requestLogger: ctx.throw(404) is one info line plus the completion', async () => {
  const { status, lines } = await logsFor((ctx) =>
    ctx.throw(404, 'no such picture'),
  );

  assert.equal(status, 404);

  assert.deepEqual(
    lines.map(({ level, msg }) => [level, msg]),
    [
      [30, 'no such picture'],
      [30, 'request completed'],
    ],
  );
});

test('requestLogger: a server error is one error line with the real error', async () => {
  const { status, lines } = await logsFor(() => {
    throw new Error('database gone');
  });

  assert.equal(status, 500);

  assert.equal(errors(lines).length, 1, JSON.stringify(lines));

  assert.equal(errors(lines)[0].err?.message, 'database gone');
});

test('requestLogger: an upstream 4xx is a server error, not the client', async () => {
  // e.g. OsmHttpError(403): a status, but not ctx.throw's `expose`
  const { lines } = await logsFor(() => {
    throw Object.assign(new Error('OSM answered HTTP 403'), { status: 403 });
  });

  assert.equal(errors(lines).length, 1, JSON.stringify(lines));

  assert.equal(errors(lines)[0].err?.message, 'OSM answered HTTP 403');
});

test('requestLogger: a 5xx answered on purpose is a warning', async () => {
  // e.g. the WMS proxy passing an upstream's 503 on, nothing thrown
  const { status, lines } = await logsFor((ctx) => {
    ctx.status = 503;

    ctx.body = 'upstream down';
  });

  assert.equal(status, 503);

  assert.deepEqual(
    lines.map(({ level, msg }) => [level, msg]),
    [[40, 'request errored']],
  );

  // nothing was thrown, so no "failed with status code 503" is made up
  assert.equal(lines[0].err, undefined);
});

test('requestLogger: an error after the client hung up is still logged', async () => {
  const { lines } = await logsFor(
    async (ctx) => {
      await new Promise((resolve) => ctx.res.once('close', resolve));

      throw new Error('database gone');
    },
    { hangUpAfter: 50, lastLines: 2 },
  );

  assert.deepEqual(
    lines.map(({ msg }) => msg),
    ['request aborted', 'request failed after it closed'],
  );

  assert.equal(errors(lines)[0].err?.message, 'database gone');
});

test('requestLogger: a thrown null is logged, not crashed on', async () => {
  const { status, lines } = await logsFor(() => {
    throw null;
  });

  assert.equal(status, 500);

  assert.equal(errors(lines).length, 1, JSON.stringify(lines));

  assert.match(errors(lines)[0].err?.message ?? '', /non-error thrown: null/);
});

test('requestLogger: a thrown plain object keeps its content', async () => {
  const { lines } = await logsFor(() => {
    throw { code: 'ER_LOCK_DEADLOCK' };
  });

  assert.match(errors(lines)[0].err?.message ?? '', /ER_LOCK_DEADLOCK/);
});

test('isClientError: only exposed 4xx', () => {
  const thrown = (status: number, expose: boolean) =>
    Object.assign(new Error('x'), { status, expose });

  assert.equal(isClientError(thrown(404, true)), true);
  assert.equal(isClientError(thrown(403, false)), false);
  assert.equal(isClientError(thrown(500, true)), false);
  assert.equal(isClientError(null), false);
  assert.equal(isClientError('404'), false);
});

test('isHangUp: a dead client socket, not other failures', () => {
  const thrown = (code: string) => Object.assign(new Error('x'), { code });

  assert.equal(isHangUp(thrown('EPIPE')), true);
  assert.equal(isHangUp(thrown('ERR_STREAM_PREMATURE_CLOSE')), true);
  assert.equal(isHangUp(thrown('ECONNRESET')), false);
  assert.equal(isHangUp(thrown('ENOENT')), false);
  assert.equal(isHangUp(new Error('no code')), false);
  assert.equal(isHangUp(null), false);
});
