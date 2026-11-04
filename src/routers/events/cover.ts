import { mkdir, readFile, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import heicConvert from 'heic-convert';
import type { Logger } from 'pino';
import sharp from 'sharp';
import shortUuid from 'short-uuid';
import { getEnv } from '../../env.js';
import { isHeifFile } from '../../heif.js';

export const coversDir = getEnv('EVENT_COVERS_DIRECTORY');

export const MAX_COVER_INPUT_BYTES = 20 * 1024 * 1024;

/** Well above a phone's 50 MP camera's own pictures. */
const MAX_COVER_PIXELS = 100_000_000;

/** The published variants and the width each is fit into. */
export const COVER_SIZES = { large: 1600, thumb: 480 } as const;

export type CoverSize = keyof typeof COVER_SIZES;

/** A cover's name: a short UUID, so its files are immutable and unguessable. */
export const COVER_NAME_RE = /^[1-9A-HJ-NP-Za-km-z]{20,24}$/;

export const coverPath = (name: string, size: CoverSize) =>
  `${coversDir}/${name.slice(0, 2)}/${name}${size === 'large' ? '' : `-${size}`}.webp`;

/** Writes the variants of an uploaded image; rejects what sharp can't decode. */
export async function storeCover(filepath: string): Promise<string> {
  const name = shortUuid.generate();

  // sharp can't decode HEVC-coded HEIC.
  const input = (await isHeifFile(filepath))
    ? await heicConvert({
        buffer: await readFile(filepath),
        format: 'JPEG',
        quality: 1,
      })
    : filepath;

  await mkdir(dirname(coverPath(name, 'large')), { recursive: true });

  try {
    // One at a time and capped: a small file can decode to gigabytes.
    for (const [size, width] of Object.entries(COVER_SIZES)) {
      await sharp(input, { limitInputPixels: MAX_COVER_PIXELS })
        .rotate()
        .resize({ width, withoutEnlargement: true })
        .webp({ quality: 82 })
        .toFile(coverPath(name, size as CoverSize));
    }
  } catch (err) {
    await removeCover(name);

    throw err;
  }

  return name;
}

export async function removeCover(name: string, logger?: Logger) {
  await Promise.all(
    Object.keys(COVER_SIZES).map((size) =>
      unlink(coverPath(name, size as CoverSize)).catch((err) => {
        if (err.code !== 'ENOENT') {
          logger?.error({ err }, 'Error deleting event cover.');
        }
      }),
    ),
  );
}
