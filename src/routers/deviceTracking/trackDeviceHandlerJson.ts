import { RouterInstance } from '@koa/router';
import { ParameterizedContext } from 'koa';
import sql from 'sql-template-tag';
import z from 'zod';
import { runInTransaction } from '../../database.js';
import { storeTrackPoint } from '../../deviceTracking.js';
import { registerPath } from '../../openapi.js';

const LocationBodySchema = z.object({
  device_id: z.string().nonempty(),
  location: z.object({
    timestamp: z.iso.datetime(),
    coords: z.object({
      latitude: z.number().min(-90).max(90),
      longitude: z.number().min(-180).max(180),
      accuracy: z.number().min(0).optional(),
      speed: z.number().optional(), // seen -1
      heading: z.number().optional(), // seen -1
      altitude: z.number().optional(),
    }),
    is_moving: z.boolean().optional(),
    odometer: z.number().min(0).optional(),
    event: z.string().optional(),
    battery: z
      .object({
        level: z.number().min(0).max(1).optional(),
        is_charging: z.boolean().optional(),
      })
      .optional(),
    activity: z.object({ type: z.string().optional() }).optional(),
    extras: z.record(z.string(), z.unknown()).optional(),
  }),
});

const NotificationBodySchema = z.object({
  id: z.string().nonempty(),
  notificationToken: z.string().nonempty(),
});

const JsonBodySchema = z.union([NotificationBodySchema, LocationBodySchema]);

const TrackResponseSchema = z.strictObject({ id: z.uint32() });

export function attachTrackDeviceJsonHandler(router: RouterInstance) {
  registerPath('/tracking/track', {
    post: {
      summary:
        'Submit a device location update (JSON/BackgroundGeolocation format)',
      tags: ['tracking'],
      requestBody: {
        content: {
          'application/json': {
            schema: LocationBodySchema,
          },
        },
      },
      responses: {
        200: {
          content: { 'application/json': { schema: TrackResponseSchema } },
        },
        400: {},
        404: { description: 'no such tracking device' },
      },
    },
  });

  router.post('/track', jsonHandler);
}

async function jsonHandler(ctx: ParameterizedContext) {
  let body;

  try {
    body = JsonBodySchema.parse(ctx.request.body);
  } catch (err) {
    console.log(ctx.request.body);

    ctx.throw(400, err as Error);
  }

  if ('notificationToken' in body) {
    ctx.throw(400, 'notifications are not supported');
  }

  await runInTransaction(async (conn) => {
    const [item] = await conn.query(
      sql`SELECT id, maxCount, maxAge FROM trackingDevice WHERE token = ${body.device_id}`,
    );

    if (!item) {
      ctx.throw(404, 'no such tracking device');
    }

    const {
      battery,
      timestamp,
      coords: { speed, latitude, longitude, altitude, accuracy, heading },
      event,
      activity,
    } = body.location;

    try {
      const id = await storeTrackPoint(
        conn,
        item.id,
        item.maxAge,
        item.maxCount,
        undefined,
        speed === -1 ? undefined : speed,
        latitude,
        longitude,
        altitude,
        accuracy,
        undefined,
        heading === -1 ? undefined : heading,
        battery?.level === undefined
          ? undefined
          : Math.floor(battery?.level * 100),
        undefined,
        [event, activity?.type].filter((a) => a).join(', ') || undefined,
        new Date(timestamp),
      );

      ctx.body = { id };
    } catch (err) {
      if (err instanceof Error && err.message === 'invalid param') {
        ctx.throw(400, 'one or more values provided are not valid');
      }

      throw err;
    }
  });
}
