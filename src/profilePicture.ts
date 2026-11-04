import got from 'got';
import heicConvert from 'heic-convert';
import sharp from 'sharp';
import { isHeif } from './heif.js';
import { appLogger } from './logger.js';

const logger = appLogger.child({ module: 'profilePicture' });

const FETCH_TIMEOUT_MS = 10_000;
export const MAX_PICTURE_INPUT_BYTES = 5 * 1024 * 1024;
const SIZE = 256;

/**
 * `contain` fits the whole image into the square, for a logo whose text a crop
 * would cut; a photo is cropped (`cover`).
 */
export async function processProfilePicture(
  input: Uint8Array,
  fit: 'cover' | 'contain' = 'cover',
): Promise<Buffer> {
  if (input.length > MAX_PICTURE_INPUT_BYTES) {
    throw new Error('profile picture too large');
  }

  // sharp can't decode HEVC-coded HEIC, so transcode it to JPEG first; sharp
  // then re-encodes to WebP like any other input.
  const decoded = isHeif(input)
    ? await heicConvert({ buffer: input, format: 'JPEG', quality: 1 })
    : input;

  return await sharp(decoded)
    .rotate()
    .resize(SIZE, SIZE, {
      fit,
      background: { r: 255, g: 255, b: 255, alpha: 0 },
    })
    .webp({ quality: 85 })
    .toBuffer();
}

export async function fetchAndProcessProfilePicture(
  url: string,
  fit?: 'cover' | 'contain',
): Promise<Buffer | null> {
  try {
    const buffer = await got(url, {
      timeout: { request: FETCH_TIMEOUT_MS },
      followRedirect: true,
      retry: { limit: 0 },
    }).buffer();

    return await processProfilePicture(buffer, fit);
  } catch (err) {
    logger.warn({ err, url }, 'failed to fetch/process profile picture');

    return null;
  }
}
