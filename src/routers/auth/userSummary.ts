import z from 'zod';
import {
  CommonUserSchema,
  PROVIDER_ID_COLUMNS,
  UserRow,
  zDateToIso,
  zNullableDateToIso,
} from '../../types.js';

export const UserSummarySchema = z
  .object({
    ...CommonUserSchema,
    createdAt: zDateToIso,
    premiumExpiration: zNullableDateToIso,
    providers: z.partialRecord(
      z.enum(PROVIDER_ID_COLUMNS),
      z.union([z.string(), z.number()]),
    ),
  })
  .meta({ id: 'UserSummary' });

export function summarize(user: UserRow) {
  return UserSummarySchema.parse({
    ...user,
    providers: Object.fromEntries(
      PROVIDER_ID_COLUMNS.filter((c) => user[c] != null).map((c) => [
        c,
        user[c],
      ]),
    ),
  });
}
