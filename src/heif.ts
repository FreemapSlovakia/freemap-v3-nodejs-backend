import { open } from 'node:fs/promises';

// HEIF (HEIC) `ftyp` major/compatible brands, as found at bytes 8–12 of the file.
const HEIF_BRANDS = new Set([
  'heic',
  'heix',
  'heim',
  'heis',
  'hevc',
  'hevx',
  'hevm',
  'hevs',
  'mif1',
  'msf1',
  'heif',
]);

function brandAt(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(
    bytes[offset],
    bytes[offset + 1],
    bytes[offset + 2],
    bytes[offset + 3],
  );
}

export function isHeif(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 12 &&
    brandAt(bytes, 4) === 'ftyp' &&
    HEIF_BRANDS.has(brandAt(bytes, 8))
  );
}

export async function isHeifFile(filepath: string): Promise<boolean> {
  const fh = await open(filepath, 'r');

  try {
    const buf = Buffer.alloc(12);

    const { bytesRead } = await fh.read(buf, 0, 12, 0);

    return bytesRead === 12 && isHeif(buf);
  } finally {
    await fh.close();
  }
}
