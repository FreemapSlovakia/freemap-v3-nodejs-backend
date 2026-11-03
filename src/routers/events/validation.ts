import z from 'zod';
import { PointSchema, VisibilitySchema } from './types.js';

/** Makes a map an event, or replaces its event. */
export const EventBodySchema = z
  .strictObject({
    description: z.string().max(16384).nullish(),
    startAt: z.iso.datetime(),
    endAt: z.iso.datetime().nullish(),
    // Where the event is shown and filtered by area.
    startPoint: PointSchema,
    filterLocation: PointSchema.nullish(),
    visibility: VisibilitySchema.default('public'),
  })
  .meta({ id: 'EventBody' });
