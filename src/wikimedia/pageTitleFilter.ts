/**
 * Commons' geotagged "camera" set includes huge bulk uploads that aren't
 * photographs — most visibly national orthophoto/map raster tiles (e.g.
 * Brandenburg's DOP20 `.tif` grid), which pollute the photo layer with regular
 * grids and don't even thumbnail. We keep only files whose title ends in a
 * photographic raster extension.
 */
export const PHOTO_EXT = /\.(jpe?g|png|webp)$/i;

/**
 * Astronaut / spaceflight photography (ISS, Space Shuttle, Apollo, …) is
 * geotagged to the ground area it depicts, but it's shot from orbit — so it
 * scatters across the map at places it wasn't taken. These uploads use
 * systematic NASA frame ids in their filenames, e.g. `ISS028-E-25372`,
 * `STS-135-…`, `AS11-40-5875`. (Deliberately does NOT match `S<lat>E<lon>`
 * coordinate-style names, which are legitimate coordinate-named photos.)
 */
export const SPACE_PHOTO =
  /^(ISS\d+[-_ ]?e[-_ ]?\d+|STS[-_ ]?\d+|AS\d+-\d+-\d+)/i;

/**
 * Systematic non-photograph bulk uploads that arrive in ordinary photo formats
 * (so the extension check can't catch them) — chiefly national orthophoto
 * surveys, which tile whole regions into a grid. Matched by the keywords their
 * titles always carry: `orthophoto`/`orthofoto`/`ortofoto`, and the German `DOP`
 * (Digitales Orthophoto, e.g. "DOP20") tile designator.
 */
export const NON_PHOTO_TITLE = /ortho(photo|foto)|ortofoto|\bDOP\d*\b/i;

/**
 * A geotagged file we want on the photo layer: a real photograph — not shot
 * from orbit and not a systematic orthophoto/survey tile.
 */
export function isPhotoTitle(title: string): boolean {
  return (
    PHOTO_EXT.test(title) &&
    !SPACE_PHOTO.test(title) &&
    !NON_PHOTO_TITLE.test(title)
  );
}

/**
 * A membership set for Commons pageIds backed by a bit array rather than a JS
 * `Set` (which caps at ~16.7M entries — and there are &gt;36M geotagged pages).
 * `capacity` covers pageIds `0..capacity-1`; 1&lt;&lt;29 ≈ 537M (64 MB) is well above
 * Commons' current ~195M and leaves years of headroom.
 */
export function makeBitset(capacity = 1 << 29) {
  const bits = new Uint8Array(capacity >> 3);

  return {
    set(id: number): void {
      if (id >= 0 && id < capacity) {
        bits[id >> 3] |= 1 << (id & 7);
      }
    },
    has(id: number): boolean {
      return (
        id >= 0 && id < capacity && (bits[id >> 3] & (1 << (id & 7))) !== 0
      );
    },
  };
}
