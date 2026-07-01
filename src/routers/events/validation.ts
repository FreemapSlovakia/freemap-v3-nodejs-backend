import z from 'zod';
import { PointSchema, VisibilitySchema } from './types.js';

/** Body for creating an event. */
export const EventBodySchema = z
  .strictObject({
    mapId: z.string().min(1).max(8),
    title: z.string().min(1).max(255),
    description: z.string().max(16384).nullish(),
    startAt: z.iso.datetime(),
    endAt: z.iso.datetime().nullish(),
    startPoint: PointSchema.nullish(),
    filterLocation: PointSchema.nullish(),
    visibility: VisibilitySchema.default('public'),
  })
  .meta({ id: 'EventBody' });

/** Body for patching an event; every field optional. */
export const EventPatchSchema = z
  .strictObject({
    mapId: z.string().min(1).max(8).optional(),
    title: z.string().min(1).max(255).optional(),
    description: z.string().max(16384).nullish(),
    startAt: z.iso.datetime().optional(),
    endAt: z.iso.datetime().nullish(),
    startPoint: PointSchema.nullish(),
    filterLocation: PointSchema.nullish(),
    visibility: VisibilitySchema.optional(),
  })
  .meta({ id: 'EventPatch' });
