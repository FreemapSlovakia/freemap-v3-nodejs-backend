import z from 'zod';
import { zDateToIso, zNullableDateToIso } from '../../types.js';

/** A geographic point as sent/received by the client. */
export const PointSchema = z
  .strictObject({
    lat: z.number().min(-90).max(90),
    lon: z.number().min(-180).max(180),
  })
  .meta({ id: 'EventPoint' });

export const VisibilitySchema = z.enum(['public', 'unlisted']);

/** Public representation of an event. */
export const EventSchema = z
  .strictObject({
    id: z.string().nonempty(),
    ownerId: z.uint32(),
    mapId: z.string().nonempty(),
    title: z.string(),
    description: z.string().nullable(),
    startAt: zDateToIso,
    endAt: zNullableDateToIso,
    startPoint: PointSchema.nullable(),
    filterLocation: PointSchema.nullable(),
    visibility: VisibilitySchema,
    // Reserved for later; always null for now.
    activityType: z.string().nullable(),
    difficulty: z.string().nullable(),
    createdAt: zDateToIso,
    updatedAt: zDateToIso,
    canWrite: z.boolean(),
  })
  .meta({ id: 'Event' });

/** Row shape read from the `event` table (dates still as JS Date). */
export const EventRowSchema = z.object({
  id: z.string().nonempty(),
  ownerId: z.uint32(),
  mapId: z.string().nonempty(),
  title: z.string(),
  description: z.string().nullable(),
  startAt: z.date(),
  endAt: z.date().nullable(),
  startLat: z.number().nullable(),
  startLon: z.number().nullable(),
  filterLat: z.number().nullable(),
  filterLon: z.number().nullable(),
  visibility: VisibilitySchema,
  activityType: z.string().nullable(),
  difficulty: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type EventRow = z.infer<typeof EventRowSchema>;

/** Maps a DB row to the public {@link EventSchema} shape. */
export function eventRowToResponse(row: EventRow, canWrite: boolean) {
  return EventSchema.parse({
    id: row.id,
    ownerId: row.ownerId,
    mapId: row.mapId,
    title: row.title,
    description: row.description,
    startAt: row.startAt,
    endAt: row.endAt,
    startPoint:
      row.startLat === null || row.startLon === null
        ? null
        : { lat: row.startLat, lon: row.startLon },
    filterLocation:
      row.filterLat === null || row.filterLon === null
        ? null
        : { lat: row.filterLat, lon: row.filterLon },
    visibility: row.visibility,
    activityType: row.activityType,
    difficulty: row.difficulty,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    canWrite,
  });
}

/** SQL column list for SELECTing an event row into {@link EventRowSchema}. */
export const EVENT_COLUMNS_SQL =
  'id, ownerId, mapId, title, description, startAt, endAt, ' +
  'startLat, startLon, filterLat, filterLon, ' +
  'visibility, activityType, difficulty, createdAt, updatedAt';
