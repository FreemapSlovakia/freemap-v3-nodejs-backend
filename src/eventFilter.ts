import type { PoolConnection } from 'mariadb';
import sql from 'sql-template-tag';
import z from 'zod';
import { DifficultySchema, TransportSchema } from './routers/events/types.js';

/** A period from now: weeks or months. */
export const WithinSchema = z.enum(['1w', '2w', '1m', '3m']);

/** Inclusive; either end may be open. */
const RangeSchema = z.strictObject({
  min: z.number().nonnegative().optional(),
  max: z.number().nonnegative().optional(),
});

/**
 * What a saved events filter asks for, as `GET /events` reads it: meters and
 * seconds. No fixed dates; a period counts from whenever it is applied.
 */
export const EventFilterSchema = z
  .strictObject({
    within: WithinSchema.optional(),
    near: z
      .strictObject({
        lat: z.number().min(-90).max(90),
        lon: z.number().min(-180).max(180),
        /** Km. */
        radius: z.number().positive().max(1000),
      })
      .optional(),
    transport: TransportSchema.array().max(16).optional(),
    /** Meters. */
    distance: RangeSchema.optional(),
    /** Seconds. */
    duration: RangeSchema.optional(),
    /** Meters. */
    ascent: RangeSchema.optional(),
    difficulty: DifficultySchema.array().max(4).optional(),
    dogs: z.boolean().optional(),
    children: z.boolean().optional(),
    /** Only imported events, or only the others. */
    imported: z.boolean().optional(),
    /** Lets events that leave transport, difficulty or a range unsaid through. */
    unsaid: z.boolean().optional(),
  })
  .meta({ id: 'EventFilter' });

export type EventFilter = z.infer<typeof EventFilterSchema>;

/** Saved filters one user may have. */
export const MAX_EVENT_FILTERS = 20;

/**
 * Assignments turning a filter's emails on or off; turned on, they cover
 * events added from now. Must precede any other `notify` assignment.
 */
export const notifySets = (notify: boolean) => [
  ...(notify ? [sql`matchSince = IF(notify, matchSince, NOW())`] : []),
  sql`notify = ${notify}`,
];

/** Drops the queued matches a moved `matchSince` no longer covers. */
export async function dropStaleMatches(db: PoolConnection, filterId: number) {
  await db.query(sql`
    DELETE m FROM eventFilterMatch m
    JOIN eventFilter ef ON ef.id = m.filterId
    WHERE m.filterId = ${filterId} AND m.sentAt IS NULL
      AND m.createdAt < ef.matchSince
  `);
}
