/**
 * Commons' geotagged "camera" set includes huge bulk uploads that aren't
 * photographs — most visibly national orthophoto/map raster tiles (e.g.
 * Brandenburg's DOP20 `.tif` grid), which pollute the photo layer with regular
 * grids and don't even thumbnail. We keep only files whose title ends in a
 * photographic raster extension.
 */
export const PHOTO_EXT = /\.(jpe?g|png|webp)$/i;

const SPACE_PHOTO = /^(ISS\d+[-_ ]?e[-_ ]?\d+|STS[-_ ]?\d+|AS\d+-\d+-\d+)/i;

const ORTHOPHOTO =
  /ortho(photo|foto)|ortofoto|(?<![\p{L}\p{N}])DOP(?:\d[a-z0-9]*)?(?![\p{L}\p{N}])/iu;

const BILDFLUG = /Bildflug/i;

const STREIFEN = /Streifen/i;

/**
 * Bulk upload programmes to keep off the photo layer, by what their titles look
 * like. Held as one table rather than as separate constants ANDed together in
 * {@link isPhotoTitle}: adding a programme is then a single entry here, and —
 * the point — cannot be half-done. An unused exported regex raises nothing, so
 * the old shape let you add a pattern and silently forget to consult it.
 *
 * Title matching is a blunt instrument, and deliberately so: `gt_type='camera'`
 * in the geo_tags dump already encodes the distinction we actually want (where
 * the camera was, not what is depicted), and everything below is mopping up
 * uploads their own submitters mistagged. Before adding a fifth pattern, note
 * that the image dump already stages `img_actor` as `wm_img.authorId` — each of
 * these programmes is one account pushing tens of thousands of files, so an
 * actor id excludes a whole programme at the join, survives them renaming their
 * scheme, and catches their files that omit the keyword. Commons categories
 * would be the truly right signal, but they live in a `categorylinks` dump this
 * import does not stream, and a fifth multi-GB download is not worth ~12k rows.
 */
const BULK_UPLOADS = {
  /**
   * Astronaut / spaceflight photography (ISS, Space Shuttle, Apollo, …) is
   * geotagged to the ground area it depicts, but it's shot from orbit — so it
   * scatters across the map at places it wasn't taken. These uploads use
   * systematic NASA frame ids in their filenames, e.g. `ISS028-E-25372`,
   * `STS-135-…`, `AS11-40-5875`. (Deliberately does NOT match `S<lat>E<lon>`
   * coordinate-style names, which are legitimate coordinate-named photos.)
   */
  spaceflight: (title: string) => SPACE_PHOTO.test(title),

  /**
   * Systematic non-photographs that arrive in ordinary photo formats (so the
   * extension check can't catch them) — chiefly national orthophoto surveys,
   * which tile whole regions into a grid. Matched by the keywords their titles
   * always carry: `orthophoto`/`orthofoto`/`ortofoto`, and the German `DOP`
   * (Digitales Orthophoto) tile designator, which carries a band/resolution
   * suffix as often as not: Rheinland-Pfalz ships `DOP20RGB`, Nordrhein-
   * Westfalen and Bremen `Dop10rgb`, Hamburg `Dop20c`.
   *
   * Requiring a digit right after `DOP` is most of what keeps this off ordinary
   * words like `Doppelhaus`. The rest is the boundary, which spells out
   * `\p{L}\p{N}` for two separate reasons: not `\b`, because page-dump titles
   * write spaces as underscores and `_` is a word char, so `\bDOP` would miss
   * `..._DOP_...`; and not ASCII, because an ASCII-only lookaround reads every
   * accented letter as a boundary, which had bare `DOP` matching inside the
   * Slovak and Czech titles this gallery is full of — `Dopĺňanie…`, `Dopředu…`.
   */
  orthophoto: (title: string) => ORTHOPHOTO.test(title),

  /**
   * Scanned frames from systematic aerial survey flights. Unlike the orthophoto
   * tiles these really are photographs, but they're shot straight down from a
   * survey aircraft and geotagged to the ground they depict, so they carpet the
   * map in flight-strip grids just as the spaceflight uploads do. The visible
   * case is the Landesarchiv Baden-Württemberg's ~12.5k 1950s frames, titled
   * `Bildflug <n>, Streifen <n>, Bildnummer <range> - LABW - …`.
   *
   * Both terms are required, in either order: `Bildflug` ("photo flight") alone
   * also turns up in ordinary ground photos that merely mention one, and
   * `Streifen` ("strip") alone is an everyday word. Two plain tests rather than
   * one `^(?=.*Bildflug)(?=.*Streifen)` — the anchored form reads like it does
   * less work and measures ~6× slower, because each `.*` still scans the whole
   * title while the leading `^`+lookahead denies V8 its literal-prefix fast
   * scan. It also would not match across a newline, where these do.
   */
  aerialSurvey: (title: string) => BILDFLUG.test(title) && STREIFEN.test(title),
} satisfies Record<string, (title: string) => boolean>;

/** Hoisted so the hot path below doesn't rebuild the list per title. */
const BULK_UPLOAD_TESTS = Object.values(BULK_UPLOADS);

/**
 * A geotagged file we want on the photo layer: a real photograph taken from the
 * ground — not shot from orbit or from a survey aircraft, and not a systematic
 * orthophoto tile. Runs over every geotagged title in the page dump (~31M), so
 * measure before making it fancier.
 */
export function isPhotoTitle(title: string): boolean {
  return (
    PHOTO_EXT.test(title) && !BULK_UPLOAD_TESTS.some((test) => test(title))
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
