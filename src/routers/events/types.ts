import sql, { raw } from 'sql-template-tag';
import z from 'zod';
import type { User } from '../../koaTypes.js';
import { isOwnerOrRole } from '../../roles.js';
import {
  PROVIDER_ID_COLUMNS,
  zDateToIso,
  zNullableDateToIso,
} from '../../types.js';

export const PointSchema = z
  .strictObject({
    lat: z.number().min(-90).max(90),
    lon: z.number().min(-180).max(180),
  })
  .meta({ id: 'EventPoint' });

export const VisibilitySchema = z.enum(['public', 'unlisted']);

export const ParticipationSchema = z.enum(['interested', 'going']);

/** A kind of transport (`bike`, `hiking`); no comma, as they are stored joined. */
export const TransportSchema = z.string().regex(/^[a-z0-9-]{1,20}$/);

/** The transports an event suits; empty where unsaid. Joined, they fit the column. */
export const TransportsSchema = z.array(TransportSchema).max(16);

/** The trip stats, as typed or filled from the linked map. */
export const StatsShape = {
  /** Meters. */
  distance: z.uint32().nullable(),
  /** Seconds. */
  duration: z.uint32().nullable(),
  /** Meters. */
  ascent: z.uint32().nullable(),
  /** Meters. */
  descent: z.uint32().nullable(),
};

export const DifficultySchema = z.enum([
  'easy',
  'moderate',
  'demanding',
  'expert',
]);

/** Who and what the trip suits; null where the organizer didn't say. */
export const AttributesShape = {
  difficulty: DifficultySchema.nullable(),
  dogs: z.boolean().nullable(),
  children: z.boolean().nullable(),
};

/** The organizer, as the app shows a user: avatar, name, premium mark. */
export const EventUserSchema = z
  .strictObject({
    id: z.uint32(),
    name: z.string(),
    hasPicture: z.boolean(),
    premium: z.boolean(),
  })
  .meta({ id: 'EventUser' });

export const EventSchema = z
  .strictObject({
    id: z.string().nonempty(),
    userId: z.uint32(),
    user: EventUserSchema,
    mapId: z.string().nullable(),
    /** The linked map's name, while it is linked. */
    mapName: z.string().nullable(),
    title: z.string(),
    description: z.string().nullable(),
    startAt: zDateToIso,
    endAt: zNullableDateToIso,
    /** No time was given: `startAt` and `endAt` are UTC midnights of their days. */
    dateOnly: z.boolean(),
    startPoint: PointSchema,
    visibility: VisibilitySchema,
    /** A harvested event's `<source>:<id there>`; null for one entered by hand. */
    sourceKey: z.string().nullable(),
    /** Harvested and still on the source's account, which nobody logs into:
     * no organizer here reads its discussion or sees who comes. */
    imported: z.boolean(),
    /** The cover image's name, for `/events/covers/{name}`. */
    cover: z.string().nullable(),
    transports: TransportsSchema,
    ...StatsShape,
    ...AttributesShape,
    createdAt: zDateToIso,
    updatedAt: zDateToIso,
    canWrite: z.boolean(),
    interestedCount: z.uint32(),
    goingCount: z.uint32(),
    /** The caller's own; null when logged out or undecided. */
    myParticipation: ParticipationSchema.nullable(),
  })
  .meta({ id: 'Event' });

export const EventRowSchema = z.object({
  id: z.string().nonempty(),
  userId: z.uint32(),
  mapId: z.string().nullable(),
  mapName: z.string().nullable(),
  title: z.string(),
  description: z.string().nullable(),
  startAt: z.date(),
  endAt: z.date().nullable(),
  dateOnly: z.boolean(),
  startLat: z.number(),
  startLon: z.number(),
  visibility: VisibilitySchema,
  sourceKey: z.string().nullable(),
  imported: z.coerce.boolean(),
  cover: z.string().nullable(),
  transports: z
    .string()
    .nullable()
    .transform((s) => (s ? s.split(',') : [])),
  ...StatsShape,
  ...AttributesShape,
  createdAt: z.date(),
  updatedAt: z.date(),
  userName: z.string(),
  userHasPicture: z.coerce.boolean(),
  userPremium: z.coerce.boolean(),
  interestedCount: z.coerce.number(),
  goingCount: z.coerce.number(),
  myParticipation: ParticipationSchema.nullable(),
});

export type EventRow = z.infer<typeof EventRowSchema>;

const summaryFields = {
  id: true,
  userId: true,
  title: true,
  startAt: true,
  endAt: true,
  dateOnly: true,
  transports: true,
  distance: true,
  duration: true,
  ascent: true,
  difficulty: true,
  dogs: true,
  children: true,
  imported: true,
  myParticipation: true,
} as const;

/** What the layer needs for a marker, its colour and its list row; the rest by the event's id. */
export const EventSummarySchema = z
  .strictObject({
    ...EventSchema.pick(summaryFields).shape,
    startPoint: PointSchema,
  })
  .meta({ id: 'EventSummary' });

export const EventSummaryRowSchema = z.object({
  ...EventRowSchema.pick(summaryFields).shape,
  startLat: z.number(),
  startLon: z.number(),
});

/**
 * {@link EventSchema}'s `imported`, as SQL on `e` and its owner `u`: harvested
 * and owned by an account with no way in (`hasWayIn`), as harvests' are.
 */
export const importedSql = sql`(e.sourceKey IS NOT NULL AND u.emailVerified = 0 AND ${raw(
  PROVIDER_ID_COLUMNS.map((c) => `u.${c} IS NULL`).join(' AND '),
)})`;

/** `SELECT … FROM` the events as {@link EventSummaryRowSchema} reads them. */
export const eventSummarySelect = (user: User | undefined) => sql`
  SELECT e.id, e.userId, e.title, e.startAt, e.endAt, e.dateOnly, e.startLat,
    e.startLon, e.transports, e.distance, e.duration, e.ascent, e.difficulty,
    e.dogs, e.children, ${importedSql} AS imported, me.status AS myParticipation
  FROM event e
    JOIN user u ON u.id = e.userId
    LEFT JOIN eventParticipant me ON me.eventId = e.id AND me.userId = ${user?.id ?? null}`;

export function eventSummaryRowToResponse(
  row: z.infer<typeof EventSummaryRowSchema>,
) {
  const { startLat, startLon, ...rest } = row;

  return EventSummarySchema.parse({
    ...rest,
    startPoint: { lat: startLat, lon: startLon },
  });
}

/**
 * When an event is over, as SQL, generously: the viewer's zone is unknown. A
 * date-only one lasts its last day through wherever that day still is (until
 * it ends at UTC−12); a timed one without an end, the rest of its day.
 */
export const eventEndSql = sql`CASE
  WHEN e.dateOnly THEN COALESCE(e.endAt, e.startAt) + INTERVAL 36 HOUR
  WHEN e.endAt IS NULL THEN e.startAt + INTERVAL 24 HOUR
  ELSE e.endAt
END`;

/** A date-only event's bounds are UTC midnights, read as the same day in every zone. */
export const datesFitDateOnly = (dates: (Date | null)[]) =>
  dates.every((d) => !d || d.getTime() % 86_400_000 === 0);

/** A source events are harvested from, e.g. `kct`. */
const SOURCE = '[a-z0-9-]{1,32}';

export const SourceSchema = z.string().regex(new RegExp(`^${SOURCE}$`));

/** A harvested event's key: `<source>:<id there>`. */
export const SourceKeySchema = z
  .string()
  .regex(new RegExp(`^${SOURCE}:[\\x21-\\x7e]{1,200}$`));

/**
 * `SELECT … FROM` the events as {@link EventRowSchema} reads them, the caller's
 * own participation included; `e` is the event, for a `WHERE` to follow.
 */
export const eventSelect = (user: User | undefined) => sql`
  SELECT e.id, e.userId, e.mapId, map.name AS mapName, e.title, e.description,
    e.startAt, e.endAt, e.dateOnly, e.startLat, e.startLon, e.visibility,
    e.sourceKey, ${importedSql} AS imported, e.cover,
    e.transports, e.distance, e.duration, e.ascent, e.descent,
    e.difficulty, e.dogs, e.children, e.createdAt, e.updatedAt,
    u.name AS userName, u.picture IS NOT NULL AS userHasPicture,
    (u.premiumExpiration IS NOT NULL AND u.premiumExpiration > NOW()) AS userPremium,
    (SELECT COUNT(*) FROM eventParticipant p WHERE p.eventId = e.id AND p.status = 'interested') AS interestedCount,
    (SELECT COUNT(*) FROM eventParticipant p WHERE p.eventId = e.id AND p.status = 'going') AS goingCount,
    me.status AS myParticipation
  FROM event e
    JOIN user u ON u.id = e.userId
    LEFT JOIN map ON map.id = e.mapId
    LEFT JOIN eventParticipant me ON me.eventId = e.id AND me.userId = ${user?.id ?? null}`;

export const canWriteEvent = (
  user: User | undefined,
  row: { userId: number },
) => isOwnerOrRole(user, row.userId, 'eventManager');

export function eventRowToResponse(row: EventRow, user: User | undefined) {
  const { startLat, startLon, userName, userHasPicture, userPremium, ...rest } =
    row;

  return EventSchema.parse({
    ...rest,
    user: {
      id: row.userId,
      name: userName,
      hasPicture: userHasPicture,
      premium: userPremium,
    },
    startPoint: { lat: startLat, lon: startLon },
    canWrite: canWriteEvent(user, row),
  });
}
