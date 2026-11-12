import { PassThrough } from 'node:stream';
import type { RouterInstance } from '@koa/router';
import z from 'zod';
import { authenticator } from '../../authenticator.js';
import { AUTH_OPTIONAL, registerPath } from '../../openapi.js';
import { acceptValidator } from '../../requestValidators.js';
import {
  checkTrackingAccess,
  queryTrackPoints,
  SubscribeParamsSchema,
  subscriptionKey,
} from '../../trackingSubscription.js';
import {
  addTrackListener,
  type LiveTrackPoint,
  removeTrackListener,
  type TrackPointListener,
} from '../../trackRegister.js';

const DevicesSchema = SubscribeParamsSchema.array().min(1).max(50);

const QuerySchema = z.object({
  devices: z.string().meta({
    description:
      'JSON array of `{ token } | { deviceId }`, each with optional `fromTime`, `maxCount`, `maxAge`',
  }),
  since: z.coerce.number().int().nonnegative().optional().meta({
    description: 'Resume after this point id; `Last-Event-ID` takes precedence',
  }),
});

export function attachTrackingStreamHandler(router: RouterInstance) {
  registerPath('/tracking/stream', {
    get: {
      summary: 'Stream live points of tracked devices (server-sent events)',
      description:
        'Events: per device first `history` `{ token | deviceId, points }` (replaces the track), or when resuming `points` (the missed points, appended); then `point` `{ token | deviceId, …point }` for each new one; `unavailable` `{ token | deviceId, status }` (403/404) instead for a device the caller may not see; `ping` every 30 s. Event ids start once every device is caught up; each is the highest point id sent, so a reconnect resumes with only the missed points.',
      tags: ['tracking'],
      security: AUTH_OPTIONAL,
      requestParams: { query: QuerySchema },
      responses: {
        200: { content: { 'text/event-stream': { schema: z.string() } } },
        400: {},
      },
    },
  });

  router.get(
    '/stream',
    acceptValidator('text/event-stream'),
    authenticator(false, 'tracking:read'),
    async (ctx) => {
      const query = QuerySchema.safeParse(ctx.query);

      if (!query.success) {
        return ctx.throw(400, z.prettifyError(query.error));
      }

      let devicesJson: unknown;

      try {
        devicesJson = JSON.parse(query.data.devices);
      } catch {
        ctx.throw(400, 'devices is not JSON');
      }

      const devices = DevicesSchema.safeParse(devicesJson);

      if (!devices.success) {
        return ctx.throw(400, z.prettifyError(devices.error));
      }

      const lastEventId = Number.parseInt(ctx.get('Last-Event-ID'), 10);

      const since = Number.isNaN(lastEventId) ? query.data.since : lastEventId;

      const stream = new PassThrough();

      let lastId = since ?? 0;

      // Ids only once every device is caught up: a resume from a partial start would skip the rest.
      let caughtUp = false;

      const send = (event: string, data: unknown, id?: number) => {
        if (stream.writableEnded) {
          return;
        }

        if (id !== undefined && id > lastId) {
          lastId = id;
        }

        stream.write(
          `${caughtUp && lastId ? `id: ${lastId}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
        );
      };

      // A device's live points wait here until its history or catch-up is out.
      const pending = new Map<number | string, LiveTrackPoint[]>();

      const listener: TrackPointListener = (point) => {
        const queue = pending.get(point.deviceId ?? point.token ?? '');

        if (queue) {
          queue.push(point);
        } else {
          send('point', point, point.id);
        }
      };

      const keys = devices.data.map(subscriptionKey);

      const pinger = setInterval(() => send('ping', 0), 30_000);

      ctx.res.on('close', () => {
        clearInterval(pinger);

        for (const key of keys) {
          removeTrackListener(key, listener);
        }

        stream.end();
      });

      ctx.req.socket.setTimeout(0);

      ctx.req.socket.setNoDelay(true);

      ctx.set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        // nginx would otherwise buffer the stream
        'X-Accel-Buffering': 'no',
      });

      ctx.status = 200;

      ctx.body = stream;

      const { user } = ctx.state;

      (async () => {
        for (const [i, params] of devices.data.entries()) {
          const subKey = keys[i];

          const key =
            typeof subKey === 'number'
              ? { deviceId: subKey }
              : { token: subKey };

          const refusal = await checkTrackingAccess(user, params);

          // A listener added after the close would never be removed.
          if (stream.writableEnded) {
            return;
          }

          if (refusal) {
            send('unavailable', { ...key, status: refusal });

            continue;
          }

          const queue: LiveTrackPoint[] = [];

          pending.set(subKey, queue);

          // Before the query, so no point falls between.
          addTrackListener(subKey, listener);

          const points = await queryTrackPoints(params, since);

          send(
            since === undefined ? 'history' : 'points',
            { ...key, points },
            points.reduce((max, p) => Math.max(max, p.id), 0),
          );

          pending.delete(subKey);

          const sent = new Set(points.map((p) => p.id));

          for (const point of queue) {
            if (!sent.has(point.id)) {
              send('point', point, point.id);
            }
          }
        }

        caughtUp = true;

        send('ping', 0);
      })().catch((err) => {
        ctx.log.error({ err }, 'tracking stream failed');

        stream.end();
      });
    },
  );
}
