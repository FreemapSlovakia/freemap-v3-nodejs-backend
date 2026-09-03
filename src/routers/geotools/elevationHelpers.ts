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

export type Bbox = [
  minLon: number,
  minLat: number,
  maxLon: number,
  maxLat: number,
];

export type ParsedSource = {
  // stable public identifier of the source, reported by the API; kept separate
  // from `path` so that neither the filesystem layout nor a file rename leaks
  // into the API contract
  name: string;
  path: string;
  bbox: Bbox;
};

// Name reported for the global SRTM fallback dataset.
export const SRTM_SOURCE_NAME = 'srtm';

// Parse the ELEVATION_SOURCES config, in priority order (first wins). Format:
//   name:/path/a.tif:minLon,minLat,maxLon,maxLat;other:/path/b.tif:...
// Paths must not contain colons. Entries may be separated by a newline instead
// of a semicolon, so the (long) value stays readable one source per line where
// the environment can carry a multi-line value.
export function parseElevationSources(raw: string): ParsedSource[] {
  return raw
    .split(/[;\n]/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [name, path, rawBbox, ...rest] = entry.split(':');

      if (!name || !path || !rawBbox || rest.length) {
        throw new Error(`Invalid ELEVATION_SOURCES entry: ${entry}`);
      }

      const bbox = rawBbox.split(',').map(Number);

      if (bbox.length !== 4 || bbox.some(Number.isNaN)) {
        throw new Error(`Invalid bbox in ELEVATION_SOURCES entry: ${entry}`);
      }

      return { name, path, bbox: bbox as Bbox };
    });
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
