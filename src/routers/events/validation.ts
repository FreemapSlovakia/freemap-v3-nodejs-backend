import z from 'zod';
import {
  AttributesShape,
  datesFitDateOnly,
  PointSchema,
  SourceKeySchema,
  StatsShape,
  TransportsSchema,
  VisibilitySchema,
} from './types.js';

const fields = {
  /** The owner, when not the caller; an eventManager's to set. */
  userId: z.uint32().optional(),
  mapId: z.string().min(1).max(8).nullish(),
  title: z.string().trim().min(1).max(255),
  description: z.string().max(16384).nullish(),
  startAt: z.iso.datetime(),
  endAt: z.iso.datetime().nullish(),
  dateOnly: z.boolean().optional(),
  // Where the event is shown and filtered by area.
  startPoint: PointSchema,
  visibility: VisibilitySchema,
  transports: TransportsSchema.optional(),
  distance: StatsShape.distance.optional(),
  duration: StatsShape.duration.optional(),
  ascent: StatsShape.ascent.optional(),
  descent: StatsShape.descent.optional(),
  difficulty: AttributesShape.difficulty.optional(),
  dogs: AttributesShape.dogs.optional(),
  children: AttributesShape.children.optional(),
};

export const EventBodySchema = z
  .strictObject({
    ...fields,
    visibility: fields.visibility.default('public'),
    /** Creates the event, or updates the one harvested under this key; an eventManager's. */
    sourceKey: SourceKeySchema.optional(),
  })
  // As instants: the same one may be written with or without milliseconds.
  .refine((b) => !b.endAt || Date.parse(b.endAt) >= Date.parse(b.startAt), {
    message: 'endAt is before startAt',
    path: ['endAt'],
  })
  .refine(
    (b) =>
      !b.dateOnly ||
      datesFitDateOnly([
        new Date(b.startAt),
        b.endAt ? new Date(b.endAt) : null,
      ]),
    { message: 'a dateOnly event’s times must be UTC midnights' },
  )
  .meta({ id: 'EventBody' });

// From `fields`, not the body: a default there would reset what a patch omits.
export const EventPatchSchema = z
  .strictObject(fields)
  .partial()
  .meta({ id: 'EventPatch' });
