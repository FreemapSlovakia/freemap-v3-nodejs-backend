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
// Paths must not contain colons.
export function parseElevationSources(raw: string): ParsedSource[] {
  return raw
    .split(';')
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
