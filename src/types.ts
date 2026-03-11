import 'zod-openapi';
import z from 'zod';

export const zNullableDateToIso = z
  .date()
  .nullable()
  .transform((d) => (d === null ? null : d.toISOString()))
  .pipe(z.iso.datetime())
  .nullable();

export const zNullishDateToIso = z
  .date()
  .nullish()
  .transform((d) => (d == null ? null : d.toISOString()))
  .pipe(z.iso.datetime())
  .nullish();

export const zDateToIso = z
  .date()
  .transform((d) => d.toISOString())
  .pipe(z.iso.datetime());

export const TrackingDeviceSchema = z
  .strictObject({
    id: z.uint32(),
    name: z.string().nonempty(),
    token: z.string().nonempty(),
    createdAt: zDateToIso,
    maxCount: z.uint32().nullable(),
    maxAge: z.uint32().nullable(),
    userId: z.uint32(),
  })
  .meta({ id: 'TrackingDevice' });

export const AccessTokenSchema = z
  .strictObject({
    id: z.uint32(),
    token: z.string().nonempty(),
    createdAt: zDateToIso,
    timeFrom: zNullableDateToIso,
    timeTo: zNullableDateToIso,
    listingLabel: z.string().nullable(),
    note: z.string().nullable(),
  })
  .meta({ id: 'AccessToken' });

export const DeviceBodySchema = z
  .strictObject({
    name: z.string().min(1).max(255),
    maxCount: z.uint32().nullish(),
    maxAge: z.uint32().nullish(),
    token: z.string().optional(),
  })
  .meta({ id: 'DeviceBody' });

export const TokenBodySchema = z
  .strictObject({
    timeFrom: z.iso.datetime().nullish(),
    timeTo: z.iso.datetime().nullish(),
    note: z.string().max(255).nullish(),
    listingLabel: z.string().max(255).nullish(),
  })
  .meta({ id: 'TokenBody' });

export const UserResponseSchema = z
  .strictObject({
    id: z.uint32(),
    name: z.string(),
    email: z.email().nullable(),
    authToken: z.string().nonempty(),
    authProviders: z.array(z.enum(['osm', 'facebook', 'google', 'garmin'])),
    isAdmin: z.boolean(),
    language: z.string().nullable(),
    lat: z.number().nullable(),
    lon: z.number().nullable(),
    premiumExpiration: z.iso.datetime().nullable(),
    sendGalleryEmails: z.boolean(),
    settings: z.record(z.string(), z.unknown()).nullable(),
    credits: z.number().nonnegative(),
  })
  .meta({ id: 'UserResponse' });

export const LoginResponseSchema = z
  .strictObject({
    user: UserResponseSchema,
    connect: z.boolean(),
    clientData: z.unknown(),
  })
  .meta({ id: 'LoginResponse' });

export const MapMetaSchema = z
  .strictObject({
    id: z.string().nonempty(),
    name: z.string().nullable(),
    public: z.boolean(),
    userId: z.uint32(),
    createdAt: z.iso.datetime(),
    modifiedAt: z.iso.datetime(),
    writers: z.array(z.uint32()).optional().meta({ description: 'User IDs' }),
    canWrite: z.boolean(),
  })
  .meta({ id: 'MapMeta' });

export const UserRowSchema = z.object({
  id: z.uint32(),
  osmId: z.uint32().nullable(),
  facebookUserId: z.string().nullable(),
  googleUserId: z.string().nullable(),
  garminUserId: z.string().nullable(),
  garminAccessToken: z.string().nullable(),
  garminAccessTokenSecret: z.string().nullable(),
  name: z.string(),
  email: z.email().nullable(),
  isAdmin: z.boolean(),
  createdAt: z.date(),
  lat: z.number().nullable(),
  lon: z.number().nullable(),
  settings: z
    .string()
    .transform((s, ctx) => {
      try {
        return JSON.parse(s);
      } catch (e) {
        ctx.addIssue({ code: 'custom', message: 'Invalid JSON: ' + e });
        return z.NEVER;
      }
    })
    .pipe(z.record(z.string(), z.unknown())),
  sendGalleryEmails: z.boolean(),
  premiumExpiration: z.date().nullable(),
  credits: z.number(),
  language: z.string().nullable(),
});

export type UserRow = z.infer<typeof UserRowSchema>;
