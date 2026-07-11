/**
 * A picture id from the `/gallery/pictures/:id` routes. A plain number refers to
 * an own gallery photo; a `w`-prefixed number (e.g. `w12345`) refers to a
 * Wikimedia Commons photo by its stable Commons pageId.
 */
export type PictureRef =
  | { source: 'gallery'; id: number }
  | { source: 'wikimedia'; pageId: number };

export function parsePictureId(raw: string): PictureRef | null {
  if (/^\d+$/.test(raw)) {
    return { source: 'gallery', id: Number(raw) };
  }

  const m = /^w(\d+)$/.exec(raw);

  return m ? { source: 'wikimedia', pageId: Number(m[1]) } : null;
}
