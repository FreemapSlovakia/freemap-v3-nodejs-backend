import 'zod-openapi';
import z from 'zod';
import { RoleSchema } from './roles.js';

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

export const CommonUserSchema = {
  id: z.uint32(),
  name: z.string(),
  email: z.email().nullable(),
  description: z.string().nullable(),
  roles: z.array(RoleSchema),
  credits: z.number().nonnegative(),
  language: z.string().nullable(),
  sendGalleryEmails: z.boolean(),
  hasPicture: z.coerce.boolean(),
  premium: z.coerce.boolean(),
};

/** UNIQUE auth-provider ID columns on the user table. */
export const PROVIDER_ID_COLUMNS = [
  'osmId',
  'facebookUserId',
  'googleUserId',
  'garminUserId',
  'appleUserId',
  'githubUserId',
  'stravaUserId',
  'microsoftUserId',
] as const;

const USER_COLUMN_NAMES = [
  'id',
  ...PROVIDER_ID_COLUMNS,
  'garminAccessToken',
  'garminAccessTokenSecret',
  'stravaAccessToken',
  'stravaRefreshToken',
  'stravaTokenExpiresAt',
  'name',
  'email',
  'description',
  'roles',
  'createdAt',
  'lat',
  'lon',
  'settings',
  'sendGalleryEmails',
  'premiumExpiration',
  'credits',
  'language',
] as const;

/** SQL column list for SELECTing user rows without loading the picture bytes. */
export const USER_COLUMNS_SQL =
  USER_COLUMN_NAMES.join(', ') +
  ', picture IS NOT NULL AS hasPicture' +
  ', (premiumExpiration IS NOT NULL AND premiumExpiration > NOW()) AS premium';

/** Same, with each column qualified by `user.` (for joins). */
export const USER_COLUMNS_SQL_PREFIXED =
  USER_COLUMN_NAMES.map((c) => `user.${c}`).join(', ') +
  ', user.picture IS NOT NULL AS hasPicture' +
  ', (user.premiumExpiration IS NOT NULL AND user.premiumExpiration > NOW()) AS premium';

export const UserResponseSchema = z
  .object({
    ...CommonUserSchema,
    // Derived from `roles` (true when non-empty); kept for backward compatibility.
    isAdmin: z.boolean(),
    authToken: z.string().nonempty(),
    authProviders: z.array(
      z.enum([
        'osm',
        'facebook',
        'google',
        'garmin',
        'apple',
        'github',
        'strava',
        'microsoft',
      ]),
    ),
    coordinates: z
      .strictObject({ lat: z.number(), lon: z.number() })
      .nullable(),
    premiumExpiration: z
      .date()
      .nullable()
      .transform((d) => (d === null ? null : d.toISOString())),
    settings: z.record(z.string(), z.unknown()).nullable(),
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

export const UserRowSchema = z
  .object({
    ...CommonUserSchema,
    osmId: z.uint32().nullable(),
    facebookUserId: z.string().nullable(),
    googleUserId: z.string().nullable(),
    garminUserId: z.string().nullable(),
    appleUserId: z.string().nullable(),
    githubUserId: z.string().nullable(),
    stravaUserId: z.string().nullable(),
    microsoftUserId: z.string().nullable(),
    garminAccessToken: z.string().nullable(),
    garminAccessTokenSecret: z.string().nullable(),
    stravaAccessToken: z.string().nullable(),
    stravaRefreshToken: z.string().nullable(),
    stravaTokenExpiresAt: z.date().nullable(),
    createdAt: z.date(),
    lat: z.number().nullable(),
    lon: z.number().nullable(),
    settings: z.record(z.string(), z.unknown()),
    premiumExpiration: z.date().nullable(),
  })
  .transform(({ lat, lon, ...user }) => ({
    ...user,
    coordinates: lat === null || lon === null ? null : { lat, lon },
  }));

export type UserRow = z.infer<typeof UserRowSchema>;
