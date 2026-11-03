import z from 'zod';
import { MapMetaSchema } from '../../types.js';
import { MapEventSchema } from '../events/types.js';

export const MapMetaWithEventSchema = z
  .strictObject({
    ...MapMetaSchema.shape,
    event: MapEventSchema.nullable(),
  })
  .meta({ id: 'MapMetaWithEvent' });

export type Map = {
  id: string;
  name: string | null;
  public: 0 | 1;
  data: string;
  userId: number;
  writers: string | null;
  createdAt: Date;
  modifiedAt: Date;
};
