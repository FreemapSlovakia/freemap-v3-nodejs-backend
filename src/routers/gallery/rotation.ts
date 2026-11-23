import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import z from 'zod';

const execFileAsync = promisify(execFile);

/** Clockwise degrees, applied after the EXIF orientation. */
export const RotationSchema = z.literal([0, 90, 180, 270]);

export type Rotation = z.infer<typeof RotationSchema>;

// exiftran's flags: -9 is 90°, but -1 is 180° and -2 is 270°.
const EXIFTRAN_FLAGS = { 90: '-9', 180: '-1', 270: '-2' } as const;

/** Rotates a JPEG losslessly into `outPath`. */
export async function rotateJpeg(
  inPath: string,
  outPath: string,
  rotation: Exclude<Rotation, 0>,
) {
  await execFileAsync('exiftran', [
    EXIFTRAN_FLAGS[rotation],
    inPath,
    '-o',
    outPath,
  ]);
}
