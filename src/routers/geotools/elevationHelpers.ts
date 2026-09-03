import { readdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import gdal from 'gdal-async';

// WGS84 built from proj4 to force traditional lon/lat axis order (GDAL 3 would
// otherwise use lat/lon for EPSG:4326).
const wgs84 = gdal.SpatialReference.fromProj4(
  '+proj=longlat +datum=WGS84 +no_defs',
);

/** Projects WGS84 lon/lat into a dataset's own CRS, as (x, y) in that CRS. */
export type Projector = (lon: number, lat: number) => { x: number; y: number };

/**
 * Build the WGS84 -> dataset projection, or null when the dataset is already
 * geographic lon/lat (SRTM) and no projection is needed.
 *
 * Uses the dataset's SRS as-is. Rebuilding it from `toProj4()` would be lossy:
 * a proj4 string carries no datum transformation, so a dataset on a datum that
 * differs from WGS84 — OSGB36 / EPSG:27700 is the one that bites, the British
 * national grid — would be read ~100 m off target, silently returning the
 * elevation of a neighbouring hillside.
 *
 * The catch is axis order: some CRSs declare the northing/latitude first, and
 * GDAL honours that for an SRS carrying an EPSG authority, so `transformPoint`
 * hands back (y, x). That covers both projected CRSs (EPSG:5845 SWEREF99 TM,
 * EPSG:3035 LAEA) and — the one that bit GEDTM30 — plain geographic EPSG:4326,
 * whose official axis order is lat/lon; a swapped lon/lat still lands inside
 * the raster of a global dataset, so it reads the wrong continent instead of
 * failing. gdal-async 3.12 exposes no setAxisMappingStrategy to override it,
 * so detect both cases and swap.
 */
export function createProjector(
  srs: gdal.SpatialReference | null,
): Projector | null {
  if (!srs) {
    return null;
  }

  const ct = new gdal.CoordinateTransformation(wgs84, srs);

  if (!srs.EPSGTreatsAsNorthingEasting() && !srs.EPSGTreatsAsLatLong()) {
    return (lon, lat) => ct.transformPoint(lon, lat);
  }

  return (lon, lat) => {
    const { x, y } = ct.transformPoint(lon, lat);

    return { x: y, y: x };
  };
}

/** Projects a dataset's own (x, y) back to WGS84 lon/lat. */
export type InverseProjector = (
  x: number,
  y: number,
) => { lon: number; lat: number };

/**
 * The reverse of {@link createProjector}, used to work out a dataset's footprint
 * in WGS84 without hard-coding one. Same axis-order caveat, mirrored: where the
 * dataset's CRS declares the northing/latitude first, GDAL wants the *input*
 * pair in that order, so the swap moves to the arguments.
 */
export function createInverseProjector(
  srs: gdal.SpatialReference | null,
): InverseProjector | null {
  if (!srs) {
    return null;
  }

  const ct = new gdal.CoordinateTransformation(srs, wgs84);

  const swapped =
    srs.EPSGTreatsAsNorthingEasting() || srs.EPSGTreatsAsLatLong();

  return (x, y) => {
    const p = ct.transformPoint(swapped ? y : x, swapped ? x : y);

    return { lon: p.x, lat: p.y };
  };
}

export type Bbox = [
  minLon: number,
  minLat: number,
  maxLon: number,
  maxLat: number,
];

export type ParsedSource = {
  // stable public identifier of the source, reported by the API; kept separate
  // from the directory so that neither the filesystem layout nor a file rename
  // leaks into the API contract, and so several rasters can answer under one
  // name (every Sonny country reports `sonny`)
  name: string;
  path: string;
  attributions: SourceAttribution[];
  // Where the raster lies, in WGS84. Optional: `source.json` may pin it, but it
  // is normally left out and derived from the raster on first use — see
  // {@link datasetBbox}. Deriving beats transcribing, because a hand-written
  // bbox fails silently in both directions: too small and the source is never
  // consulted, too large and every miss costs a pointless read.
  bbox?: Bbox;
};

/** How a source wants to be credited, as the elevation API reports it. */
export type SourceAttribution = {
  /** The credit line itself, verbatim as the licence asks for it. */
  name: string;
  /** Where the dataset lives, when there is a page to link to. */
  url?: string;
};

// Name reported for the global SRTM fallback dataset.
export const SRTM_SOURCE_NAME = 'srtm';

// The raster a source directory holds, when `source.json` doesn't name one.
const DEFAULT_FILES = ['data.vrt', 'data.tif'];

/**
 * Load the elevation sources from a directory tree, in priority order: one
 * subdirectory per source, consulted in the order the names sort, so a numeric
 * prefix (`010-sk`, `999-gedtm30`) sets priority the way rc.d does.
 *
 * A subdirectory counts as a source only if it holds a `source.json`; anything
 * else — a half-finished download, a scratch folder, the SRTM tile cache — is
 * ignored rather than silently changing what the API serves.
 *
 *     { "name": "sonny",
 *       "file": "de.tif",
 *       "attributions": [{ "name": "Sonny's LiDAR DTM", "url": "https://..." }] }
 *
 * `file` is optional and may be absolute, so a source can point at a raster that
 * stays where it is; without it the directory must hold `data.vrt` or
 * `data.tif`. `bbox` is optional too, and normally omitted — see
 * {@link datasetBbox}.
 *
 * Nothing here throws. This runs while the module is still being evaluated, so
 * a throw takes down the whole API — gallery, routing and all — over an
 * elevation problem, and the "drop in a directory" workflow would mean one
 * malformed file could do it on the next restart. A bad source is dropped with
 * a warning and the rest still load; the request path already treats a missing
 * source as a fall-through.
 */
export function loadElevationSources(
  root: string,
  warn: (message: string, err: unknown) => void,
): ParsedSource[] {
  if (!root) {
    return [];
  }

  let dirs: string[];

  try {
    dirs = readdirSync(root).sort();
  } catch (err) {
    warn(`Cannot read ELEVATION_DIR ${root}; no local sources`, err);

    return [];
  }

  const sources: ParsedSource[] = [];

  for (const dir of dirs) {
    const dirPath = join(root, dir);

    let raw: string;

    try {
      raw = readFileSync(join(dirPath, 'source.json'), 'utf8');
    } catch (err) {
      // A directory with no source.json is simply not a source. Anything else —
      // EACCES after a deploy left the wrong ownership, EIO on a bad disk — is a
      // real source going quietly missing, which is the silent under-coverage
      // this design exists to avoid. Say so.
      const code = (err as NodeJS.ErrnoException).code;

      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        warn(`Cannot read ${dirPath}/source.json; source skipped`, err);
      }

      continue;
    }

    try {
      sources.push(parseSourceJson(raw, dirPath));
    } catch (err) {
      warn(`Ignoring ${dirPath}`, err);
    }
  }

  return sources;
}

/** Parse one `source.json`, resolving its raster against its own directory. */
export function parseSourceJson(raw: string, dirPath: string): ParsedSource {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid source.json in ${dirPath}: ${err}`);
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Invalid source.json in ${dirPath}: not an object`);
  }

  const { name, file, bbox, attributions } = parsed as Record<string, unknown>;

  if (typeof name !== 'string' || !name) {
    throw new Error(`Invalid source.json in ${dirPath}: missing "name"`);
  }

  if (file !== undefined && (typeof file !== 'string' || !file)) {
    throw new Error(`Invalid source.json in ${dirPath}: bad "file"`);
  }

  if (
    bbox !== undefined &&
    (!Array.isArray(bbox) ||
      bbox.length !== 4 ||
      bbox.some((n) => typeof n !== 'number' || Number.isNaN(n)))
  ) {
    throw new Error(`Invalid source.json in ${dirPath}: bad "bbox"`);
  }

  if (attributions !== undefined && !Array.isArray(attributions)) {
    throw new Error(`Invalid source.json in ${dirPath}: bad "attributions"`);
  }

  return {
    name,
    path: file
      ? isAbsolute(file)
        ? file
        : join(dirPath, file)
      : defaultFile(dirPath),
    bbox: bbox as Bbox | undefined,
    attributions: ((attributions ?? []) as unknown[]).map((attr) => {
      if (!attr || typeof attr !== 'object') {
        throw new Error(`Invalid source.json in ${dirPath}: bad attribution`);
      }

      const { name: credit, url } = attr as Record<string, unknown>;

      if (typeof credit !== 'string' || !credit) {
        throw new Error(
          `Invalid source.json in ${dirPath}: attribution needs a "name"`,
        );
      }

      return typeof url === 'string' && url
        ? { name: credit, url }
        : { name: credit };
    }),
  };
}

function defaultFile(dirPath: string): string {
  for (const candidate of DEFAULT_FILES) {
    const full = join(dirPath, candidate);

    try {
      statSync(full);

      return full;
    } catch {
      // try the next candidate
    }
  }

  throw new Error(
    `No raster in ${dirPath}: give "file" or add ${DEFAULT_FILES.join(' / ')}`,
  );
}

/**
 * The WGS84 footprint of a raster, derived from its geotransform and CRS.
 *
 * Reprojection curves: the WGS84 outline of a projected raster is not the
 * rectangle its four corners suggest. A UTM or LAEA sheet bows between them by
 * far more than a rounding margin — on a wide one the top edge bulges well past
 * the corner latitudes — so taking the corners alone clips real coverage off
 * the sides, and the source then goes unconsulted for points it actually holds.
 *
 * So the whole footprint is sampled on a grid rather than just its outline. The
 * edges carry the bulge for the usual projections, but an extreme can also fall
 * strictly inside — a polar stereographic sheet containing the pole reaches 90°
 * at an interior pixel, on no edge at all — and an interior grid costs nothing
 * here, being computed once per source.
 *
 * A margin then absorbs what the sampling still misses between points. Erring
 * wide only costs a read that finds nodata and falls through; erring narrow
 * loses data silently, so the bias is deliberate.
 */
export function datasetBbox(
  geoTransform: number[],
  width: number,
  height: number,
  unproject: InverseProjector | null,
): Bbox {
  const [gt0, gt1, gt2, gt3, gt4, gt5] = geoTransform;

  const STEPS = 64;

  const lons: number[] = [];

  const lats: number[] = [];

  for (let i = 0; i <= STEPS; i++) {
    for (let j = 0; j <= STEPS; j++) {
      const px = (i / STEPS) * width;

      const py = (j / STEPS) * height;

      const x = gt0 + px * gt1 + py * gt2;

      const y = gt3 + px * gt4 + py * gt5;

      // a point outside the projection's valid domain transforms to a
      // non-finite value; it bounds nothing, so leave it out
      const { lon, lat } = unproject ? unproject(x, y) : { lon: x, lat: y };

      if (Number.isFinite(lon) && Number.isFinite(lat)) {
        lons.push(lon);
        lats.push(lat);
      }
    }
  }

  if (!lons.length) {
    throw new Error('Could not derive a WGS84 extent for the raster');
  }

  const margin = 0.01;

  // Not handled: a raster crossing the antimeridian would sample near both
  // +180 and -180 and yield a bbox the long way round the globe. No source
  // does, and a single bbox has no way to say "wraps" anyway.
  return [
    Math.max(-180, Math.min(...lons) - margin),
    Math.max(-90, Math.min(...lats) - margin),
    Math.min(180, Math.max(...lons) + margin),
    Math.min(90, Math.max(...lats) + margin),
  ];
}

/**
 * Record that `name` answered, keeping every distinct credit it brought.
 *
 * Both halves matter. Several rasters answer under one name, so their credits
 * accumulate instead of the last one winning; and they usually carry the *same*
 * credit, so identical entries collapse and a reader isn't told about Sonny
 * nine times for a route crossing nine of his countries.
 */
export function mergeCredits(
  into: Map<string, SourceAttribution[]>,
  name: string,
  attributions: SourceAttribution[],
) {
  const existing = into.get(name);

  if (!existing) {
    into.set(name, [...attributions]);

    return;
  }

  for (const attribution of attributions) {
    if (
      !existing.some(
        (seen) =>
          seen.name === attribution.name && seen.url === attribution.url,
      )
    ) {
      existing.push(attribution);
    }
  }
}

export function inBbox(
  [minLon, minLat, maxLon, maxLat]: Bbox,
  lat: number,
  lon: number,
) {
  return lon >= minLon && lon <= maxLon && lat >= minLat && lat <= maxLat;
}

// Derive the SRTM tile key (e.g. N48E017) covering the given coordinate.
export function srtmKey(lat: number, lon: number) {
  const alat = Math.abs(lat);

  const alon = Math.abs(lon);

  return (
    `${lat >= 0 ? 'N' : 'S'}${Math.floor(alat + (lat < 0 ? 1 : 0))
      .toString()
      .padStart(2, '0')}` +
    `${lon >= 0 ? 'E' : 'W'}${Math.floor(alon + (lon < 0 ? 1 : 0))
      .toString()
      .padStart(3, '0')}`
  );
}
