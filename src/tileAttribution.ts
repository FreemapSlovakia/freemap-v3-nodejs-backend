import z from 'zod';

const LicenseDictSchema = z.record(
  z.string(),
  z.array(z.object({ title: z.string(), url: z.string().optional() })),
);

/** The renderer's `GET /licenses`: dataset code → the sources it stands for. */
export type LicenseDict = z.infer<typeof LicenseDictSchema>;

const FREEMAP = '©\xa0Freemap Slovakia';

const OSM = 'osm';

// Seeded whatever the tiles say: the map is an OSM-derived work even where a
// tile put none of it on screen. Used when the dictionary lacks the entry.
const OSM_TITLE = '© OpenStreetMap contributors';

/**
 * The codes in a JPEG's first `COM` segment, or `null` if it has none before
 * the image data. Walks the segment chain per the JPEG spec rather than
 * trusting where the renderer puts the segment.
 */
export function readTileCodes(tile: Uint8Array): string[] | null {
  if (tile[0] !== 0xff || tile[1] !== 0xd8) {
    return null;
  }

  let at = 2;

  for (;;) {
    if (tile[at] !== 0xff) {
      return null;
    }

    // any number of 0xFF fill bytes may precede a marker
    while (tile[at] === 0xff) {
      at++;
    }

    const marker = tile[at++];

    // standalone markers carry no length
    if (
      marker === 0x01 ||
      (marker !== undefined && marker >= 0xd0 && marker <= 0xd7)
    ) {
      continue;
    }

    // start of scan or end of image: no header segments follow
    if (
      marker === undefined ||
      marker === 0xda ||
      marker === 0xd9 ||
      at + 2 > tile.length
    ) {
      return null;
    }

    const length = (tile[at]! << 8) | tile[at + 1]!;

    const end = at + length;

    if (length < 2 || end > tile.length) {
      return null;
    }

    if (marker === 0xfe) {
      return Buffer.from(tile.subarray(at + 2, end))
        .toString('utf8')
        .split(/[,\s]+/)
        .filter(Boolean);
    }

    at = end;
  }
}

/** The code as `/licenses` keys it, or `null` if it isn't one at all. */
export function expandCode(code: string): string | null {
  if (code === 'o') {
    return OSM;
  }

  const namespace = { s: 'shading', c: 'contours' }[code[0] ?? ''];

  const key = code.slice(1);

  return namespace && key ? `${namespace}:${key}` : null;
}

export async function fetchLicenses(url: string): Promise<LicenseDict> {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });

  if (!res.ok) {
    throw new Error(`GET ${url}: ${res.status}`);
  }

  return LicenseDictSchema.parse(await res.json());
}

/** Where a key sits in the line, as the renderer's burnt-in credit ranks it. */
function rank(key: string): number {
  return key === OSM ? 0 : key.endsWith(':_') ? 2 : 1;
}

function collationKey(title: string): string {
  return title.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/**
 * The credit line for the given `/licenses` keys, in the order the renderer
 * burns in and the web client lists: Freemap, OpenStreetMap, the datasets that
 * answered for somewhere alphabetically, the global fallback models last. A
 * title is named once, under the strongest rank any of its keys has. `null` if
 * any key is missing from the dictionary.
 */
export function composeCredits(
  keys: Iterable<string>,
  licenses: LicenseDict,
): string[] | null {
  const ranked = new Map<string, number>([
    [licenses[OSM]?.[0]?.title ?? OSM_TITLE, 0],
  ]);

  for (const key of keys) {
    const entries = licenses[key];

    if (!entries) {
      return null;
    }

    for (const { title } of entries) {
      ranked.set(title, Math.min(ranked.get(title) ?? Infinity, rank(key)));
    }
  }

  const sorted = [...ranked]
    .map(([title, weight]) => ({ title, weight, key: collationKey(title) }))
    .sort(
      (a, b) =>
        a.weight - b.weight || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
    );

  return [FREEMAP, ...sorted.map(({ title }) => title)];
}

/**
 * Collects the codes of every tile a download writes. Only a pass that saw
 * codes on every tile may narrow the credit to their union: one tile without
 * them may have drawn a source the union lacks.
 */
export class TileCodeCollector {
  #keys = new Set<string>();

  #complete = true;

  add(tile: Uint8Array) {
    // An empty list is a tile outside the renderer's coverage and narrows the
    // credit; no list at all must widen it.
    const codes = readTileCodes(tile);

    if (!codes) {
      this.#complete = false;

      return;
    }

    for (const code of codes) {
      const key = expandCode(code);

      if (key) {
        this.#keys.add(key);
      } else {
        this.#complete = false;
      }
    }
  }

  /**
   * The credits for what was collected, widening to every dataset the renderer
   * knows when the union can't be trusted.
   */
  credits(licenses: LicenseDict): string[] {
    return (
      (this.#complete && composeCredits(this.#keys, licenses)) ||
      composeCredits(Object.keys(licenses), licenses)!
    );
  }
}
