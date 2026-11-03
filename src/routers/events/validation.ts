import z from 'zod';
import {
  AttributesShape,
  PointSchema,
  StatsShape,
  TransportsSchema,
  VisibilitySchema,
} from './types.js';

const fields = {
  mapId: z.string().min(1).max(8).nullish(),
  title: z.string().trim().min(1).max(255),
  description: z.string().max(16384).nullish(),
  startAt: z.iso.datetime(),
  endAt: z.iso.datetime().nullish(),
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
  .strictObject({ ...fields, visibility: fields.visibility.default('public') })
  .refine((b) => !b.endAt || b.endAt >= b.startAt, {
    message: 'endAt is before startAt',
    path: ['endAt'],
  })
  .meta({ id: 'EventBody' });

// From `fields`, not the body: a default there would reset what a patch omits.
export const EventPatchSchema = z
  .strictObject(fields)
  .partial()
  .meta({ id: 'EventPatch' });
