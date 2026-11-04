import sql from 'sql-template-tag';
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
    startPoint: PointSchema,
    visibility: VisibilitySchema,
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
  startLat: z.number(),
  startLon: z.number(),
  visibility: VisibilitySchema,
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

/**
 * `SELECT … FROM` the events as {@link EventRowSchema} reads them, the caller's
 * own participation included; `e` is the event, for a `WHERE` to follow.
 */
export const eventSelect = (user: User | undefined) => sql`
  SELECT e.id, e.userId, e.mapId, map.name AS mapName, e.title, e.description,
    e.startAt, e.endAt, e.startLat, e.startLon, e.visibility, e.cover,
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
) => isOwnerOrRole(user, row.userId, 'mapModerator');

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
