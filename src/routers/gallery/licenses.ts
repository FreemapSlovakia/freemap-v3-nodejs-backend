import { z } from 'zod';

/**
 * Photo licenses a user may pick from. The id is an SPDX-style key stored
 * verbatim in `picture.license`. Kept in sync with the web app's
 * `src/features/gallery/licenses.tsx`.
 */
export const PHOTO_LICENSE_IDS = [
  'CC0-1.0',
  'CC-BY-4.0',
  'CC-BY-SA-4.0',
  'CC-BY-NC-4.0',
  'CC-BY-NC-SA-4.0',
] as const;

export const DEFAULT_PHOTO_LICENSE = 'CC-BY-SA-4.0';

export const LicenseSchema = z.enum(PHOTO_LICENSE_IDS);

export type PhotoLicense = z.infer<typeof LicenseSchema>;
