import got from 'got';
import sharp from 'sharp';
import { appLogger } from './logger.js';

const logger = appLogger.child({ module: 'profilePicture' });

const FETCH_TIMEOUT_MS = 10_000;
export const MAX_PICTURE_INPUT_BYTES = 5 * 1024 * 1024;
const SIZE = 128;

export async function processProfilePicture(
  input: Uint8Array,
): Promise<Buffer> {
  if (input.length > MAX_PICTURE_INPUT_BYTES) {
    throw new Error('profile picture too large');
  }

  return await sharp(input)
    .rotate()
    .resize(SIZE, SIZE, { fit: 'cover' })
    .webp({ quality: 85 })
    .toBuffer();
}

export async function fetchAndProcessProfilePicture(
  url: string,
): Promise<Buffer | null> {
  try {
    const buffer = await got(url, {
      timeout: { request: FETCH_TIMEOUT_MS },
      followRedirect: true,
      retry: { limit: 0 },
    }).buffer();

    return await processProfilePicture(buffer);
  } catch (err) {
    logger.warn({ err, url }, 'failed to fetch/process profile picture');

    return null;
  }
}
