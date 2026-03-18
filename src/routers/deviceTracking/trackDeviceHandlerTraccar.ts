import { RouterInstance } from '@koa/router';
import { ParameterizedContext } from 'koa';
import sql from 'sql-template-tag';
import z from 'zod';
import { runInTransaction } from '../../database.js';
import { storeTrackPoint } from '../../deviceTracking.js';
import { registerPath } from '../../openapi.js';

const KNOTS_TO_MS = 0.514444;

const TraccarPositionSchema = z.object({
  // id: z.number().optional(),
  // deviceId: z.number().optional(),
  // type: z.string().optional(), // message type
  // protocol: z.string().optional(),
  // serverTime: z.iso.datetime({ offset: true }).optional(),
  // deviceTime: z.iso.datetime({ offset: true }).optional(),
  fixTime: z.iso.datetime({ offset: true }),
  // outdated: z.boolean().optional(),
  // valid: z.boolean().optional(),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  altitude: z.number().optional(),
  speed: z.number().optional(), // knots
  course: z.number().optional(),
  accuracy: z.number().min(0).optional(),
  // address: z.string().nullable().optional(),
  // network: z.unknown().optional(),
  // geofenceIds: z.array(z.number()).nullable().optional(),
  attributes: z
    .object({
      // === navigation ===
      hdop: z.number().min(0).optional(),
      // vdop: z.number().min(0).optional(),
      // pdop: z.number().min(0).optional(),
      // sat: z.number().optional(), // satellites used
      // satVisible: z.number().optional(), // satellites visible

      // === motion / odometry ===
      // distance: z.number().optional(), // meters since last point
      // totalDistance: z.number().optional(), // cumulative meters
      motion: z.boolean().optional(),
      // odometer: z.number().optional(), // meters
      // tripOdometer: z.number().optional(),
      // hours: z.number().optional(), // engine hours in ms

      // === power ===
      batteryLevel: z.number().min(0).max(100).optional(), // 0–100 %
      // battery: z.number().optional(), // battery voltage (V)
      // power: z.number().optional(), // external power voltage (V)
      // charge: z.boolean().optional(),

      // === engine / OBD ===
      // ignition: z.boolean().optional(),
      // rpm: z.number().optional(),
      // throttle: z.number().optional(),
      // engineLoad: z.number().optional(),
      // coolantTemp: z.number().optional(),
      // obdSpeed: z.number().optional(), // km/h from OBD
      // obdOdometer: z.number().optional(),
      // fuel: z.number().optional(),
      // fuelUsed: z.number().optional(),
      // fuelConsumption: z.number().optional(),
      // dtcs: z.string().optional(), // OBD trouble codes
      // vin: z.string().optional(),

      // === I/O ===
      // input: z.number().optional(), // digital inputs bitmask
      // output: z.number().optional(), // digital outputs bitmask
      // blocked: z.boolean().optional(),

      // === alarms / events ===
      alarm: z.string().optional(),
      // status: z.number().optional(), // raw status bitmask
      // event: z.union([z.number(), z.string()]).optional(),
      activity: z.string().optional(), // passthrough from BackgroundGeolocation

      // === driver / identification ===
      // driverUniqueId: z.string().optional(),

      // === connectivity ===
      rssi: z.number().optional(),
      // ip: z.string().optional(),
      // iccid: z.string().optional(),

      // === misc ===
      // result: z.string().optional(), // command result
      // raw: z.string().optional(),
      // index: z.number().optional(),
      // archive: z.boolean().optional(),
      // approximate: z.boolean().optional(),
    })
    .optional(),
});

const TraccarBodySchema = z.object({
  position: TraccarPositionSchema,
  device: z.object({
    // id: z.number().optional(),
    uniqueId: z.string().nonempty(),
    // name: z.string().optional(),
    // status: z.string().optional(),
    // lastUpdate: z.iso.datetime({ offset: true }).optional(),
    // positionId: z.number().optional(),
    // groupId: z.number().optional(),
    // calendarId: z.number().optional(),
    // phone: z.string().nullable().optional(),
    // model: z.string().nullable().optional(),
    // contact: z.string().nullable().optional(),
    // category: z.string().nullable().optional(),
    // disabled: z.boolean().optional(),
    // expirationTime: z.unknown().optional(),
    // attributes: z.record(z.string(), z.unknown()).optional(),
  }),
});

const TrackResponseSchema = z.strictObject({ id: z.uint32() });

export function attachTrackDeviceTraccarHandler(router: RouterInstance) {
  registerPath('/tracking/traccar', {
    post: {
      summary: 'Submit a device location update (Traccar forward protocol)',
      tags: ['tracking'],
      requestBody: {
        content: {
          'application/json': {
            schema: TraccarBodySchema,
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

  router.post('/traccar', traccarHandler);
}

async function traccarHandler(ctx: ParameterizedContext) {
  let body;

  try {
    body = TraccarBodySchema.parse(ctx.request.body);
  } catch (err) {
    ctx.throw(400, err as Error);
  }

  const { position, device } = body;

  await runInTransaction(async (conn) => {
    const [item] = await conn.query(
      sql`SELECT id, maxCount, maxAge FROM trackingDevice WHERE token = ${device.uniqueId}`,
    );

    if (!item) {
      ctx.throw(404, 'no such tracking device');
    }

    const speedMs =
      position.speed !== undefined ? position.speed * KNOTS_TO_MS : undefined;

    try {
      const id = await storeTrackPoint(
        conn,
        item.id,
        item.maxAge,
        item.maxCount,
        undefined,
        speedMs,
        position.latitude,
        position.longitude,
        position.altitude,
        position.accuracy,
        position.attributes?.hdop,
        position.course,
        position.attributes?.batteryLevel,
        position.attributes?.rssi !== undefined
          ? Math.round(
              Math.max(
                0,
                Math.min(100, ((position.attributes?.rssi + 113) / 62) * 100),
              ),
            )
          : undefined,
        Array.from(
          new Set(
            [
              position.attributes?.alarm,
              position.attributes?.activity,
              position.attributes?.motion === true
                ? 'moving'
                : position.attributes?.motion === false
                  ? 'still'
                  : undefined,
            ].filter(Boolean),
          ),
        ).join(', ') || undefined,
        new Date(position.fixTime),
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
