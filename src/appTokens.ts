import { createHash, randomBytes } from 'node:crypto';
import z from 'zod';
import { zDateToIso, zNullableDateToIso } from './types.js';

// Session tokens are base64, so they never carry this prefix.
export const APP_TOKEN_PREFIX = 'fm_';

export const AppTokenScopeSchema = z
  .enum([
    'gallery:read',
    'gallery:write',
    'maps:read',
    'maps:write',
    'tracking:read',
    'tracking:write',
    'tiles:outdoor',
    'tiles:shading',
    'tiles:aerial',
  ])
  .meta({ id: 'AppTokenScope' });

export type AppTokenScope = z.infer<typeof AppTokenScopeSchema>;

export const AppTokenSchema = z
  .strictObject({
    id: z.uint32(),
    note: z.string().nullable(),
    scopes: z.array(z.string()),
    createdAt: zDateToIso,
    expiresAt: zNullableDateToIso,
    lastUsedAt: zNullableDateToIso,
    lastUserAgent: z.string().nullable(),
  })
  .meta({ id: 'AppToken' });

// The column is a TIMESTAMP.
const MAX_EXPIRES_AT = new Date('2038-01-01T00:00:00Z');

export function isValidExpiresAt(expiresAt: Date) {
  return expiresAt > new Date() && expiresAt <= MAX_EXPIRES_AT;
}

export const APP_TOKEN_COLUMNS_SQL =
  'id, note, scopes, createdAt, expiresAt, lastUsedAt, lastUserAgent';

export function generateAppToken() {
  return APP_TOKEN_PREFIX + randomBytes(32).toString('base64url');
}

export function hashAppToken(token: string) {
  return createHash('sha256').update(token).digest();
}
