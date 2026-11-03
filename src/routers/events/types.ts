import z from 'zod';
import type { User } from '../../koaTypes.js';
import { isOwnerOrRole } from '../../roles.js';
import { zDateToIso, zNullableDateToIso } from '../../types.js';

export const PointSchema = z
  .strictObject({
    lat: z.number().min(-90).max(90),
    lon: z.number().min(-180).max(180),
  })
  .meta({ id: 'EventPoint' });

export const VisibilitySchema = z.enum(['public', 'unlisted']);

/** What a map gains by being an event. */
export const MapEventSchema = z
  .strictObject({
    description: z.string().nullable(),
    startAt: zDateToIso,
    endAt: zNullableDateToIso,
    startPoint: PointSchema.nullable(),
    filterLocation: PointSchema.nullable(),
    visibility: VisibilitySchema,
    // Reserved; always null for now.
    activityType: z.string().nullable(),
    difficulty: z.string().nullable(),
    createdAt: zDateToIso,
    updatedAt: zDateToIso,
  })
  .meta({ id: 'MapEvent' });

/** An event as listed: its map's id, name and owner, and the event itself. */
export const EventSchema = z
  .strictObject({
    mapId: z.string().nonempty(),
    name: z.string().nullable(),
    userId: z.uint32(),
    canWrite: z.boolean(),
    ...MapEventSchema.shape,
  })
  .meta({ id: 'Event' });

export const MapEventRowSchema = z.object({
  mapId: z.string().nonempty(),
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

export type MapEventRow = z.infer<typeof MapEventRowSchema>;

export const EventRowSchema = z.object({
  ...MapEventRowSchema.shape,
  name: z.string().nullable(),
  userId: z.uint32(),
  writers: z
    .string()
    .nullable()
    .transform((w) => (w ? w.split(',').map(Number) : []))
    .pipe(z.number().array()),
});

/** Selects a `mapEvent` aliased `e` into {@link MapEventRowSchema}. */
export const MAP_EVENT_COLUMNS_SQL =
  'e.mapId, e.description, e.startAt, e.endAt, ' +
  'e.startLat, e.startLon, e.filterLat, e.filterLon, ' +
  'e.visibility, e.activityType, e.difficulty, e.createdAt, e.updatedAt';

/**
 * Adds the map's name, owner and writers to {@link MAP_EVENT_COLUMNS_SQL}, for
 * `FROM mapEvent e JOIN map ON map.id = e.mapId`.
 */
export const EVENT_COLUMNS_SQL =
  MAP_EVENT_COLUMNS_SQL +
  ', map.name, map.userId, ' +
  '(SELECT GROUP_CONCAT(userId) FROM mapWriteAccess WHERE mapId = e.mapId) AS writers';

function toPoint(lat: number | null, lon: number | null) {
  return lat === null || lon === null ? null : { lat, lon };
}

/** A row as {@link MapEventSchema} parses it: dates still as `Date`. */
export function mapEventFields(row: MapEventRow) {
  return {
    description: row.description,
    startAt: row.startAt,
    endAt: row.endAt,
    startPoint: toPoint(row.startLat, row.startLon),
    filterLocation: toPoint(row.filterLat, row.filterLon),
    visibility: row.visibility,
    activityType: row.activityType,
    difficulty: row.difficulty,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function eventRowToResponse(
  row: z.infer<typeof EventRowSchema>,
  canWrite: boolean,
) {
  return EventSchema.parse({
    mapId: row.mapId,
    name: row.name,
    userId: row.userId,
    canWrite,
    ...mapEventFields(row),
  });
}

/** Owner, a map moderator, or one of the map's writers. */
export function canWriteEvent(
  user: User | undefined,
  row: { userId: number; writers: number[] },
) {
  return (
    isOwnerOrRole(user, row.userId, 'mapModerator') ||
    Boolean(user && row.writers.includes(user.id))
  );
}
