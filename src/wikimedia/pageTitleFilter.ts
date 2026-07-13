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
 * (Digitales Orthophoto, e.g. "DOP20") tile designator. The `DOP` boundaries
 * use alphanumeric lookarounds, not `\b`: page-dump titles space-as-underscore,
 * and `_` is a word char, so `\bDOP` would miss `..._DOP_...`.
 */
export const NON_PHOTO_TITLE =
  /ortho(photo|foto)|ortofoto|(?<![a-z0-9])DOP\d*(?![a-z0-9])/i;

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

/**
 * Probabilistic membership set for page titles, backed by a hashed bit array (a
 * single-hash Bloom filter). It pre-filters the huge `image` dump down to the
 * kept titles before the authoritative SQL join on title — a false positive
 * just stages one extra row that later fails the join, so the only cost is a
 * little wasted work, never a wrong result. `bitCount` must be a power of two;
 * 1&lt;&lt;30 bits ≈ 128 MB gives a ~3% false-positive rate at ~31.5M titles.
 */
export function makeStringBitset(bitCount = 1 << 30) {
  const bits = new Uint8Array(bitCount >> 3);
  const mask = bitCount - 1;

  // FNV-1a over the UTF-16 code units. Both sides hash the identical decoded
  // title string (underscore form), so the exact byte encoding doesn't matter.
  function hash(s: string): number {
    let h = 0x811c9dc5;

    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }

    return (h >>> 0) & mask;
  }

  return {
    set(s: string): void {
      const i = hash(s);
      bits[i >> 3] |= 1 << (i & 7);
    },
    has(s: string): boolean {
      const i = hash(s);
      return (bits[i >> 3] & (1 << (i & 7))) !== 0;
    },
  };
}
