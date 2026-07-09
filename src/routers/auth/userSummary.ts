import z from 'zod';
import {
  CommonUserSchema,
  PROVIDER_ID_COLUMNS,
  type UserRow,
  zDateToIso,
  zNullableDateToIso,
} from '../../types.js';

export const UserSummarySchema = z
  .object({
    ...CommonUserSchema,
    // Derived from `roles` (true when non-empty); kept for backward compatibility.
    isAdmin: z.boolean(),
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
    isAdmin: user.roles.length > 0,
    providers: Object.fromEntries(
      PROVIDER_ID_COLUMNS.filter((c) => user[c] != null).map((c) => [
        c,
        user[c],
      ]),
    ),
  });
}
