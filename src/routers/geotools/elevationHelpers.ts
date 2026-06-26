export type Bbox = [
  minLon: number,
  minLat: number,
  maxLon: number,
  maxLat: number,
];

export type ParsedSource = {
  path: string;
  bbox: Bbox;
};

// Parse the ELEVATION_SOURCES config, in priority order (first wins). Format:
//   /path/a.tif:minLon,minLat,maxLon,maxLat;/path/b.tif:...
export function parseElevationSources(raw: string): ParsedSource[] {
  return raw
    .split(';')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      // split on the last colon so paths may themselves contain colons
      const sep = entry.lastIndexOf(':');

      if (sep < 0) {
        throw new Error(`Invalid ELEVATION_SOURCES entry: ${entry}`);
      }

      const path = entry.slice(0, sep);

      const bbox = entry
        .slice(sep + 1)
        .split(',')
        .map(Number);

      if (bbox.length !== 4 || bbox.some(Number.isNaN)) {
        throw new Error(`Invalid bbox in ELEVATION_SOURCES entry: ${entry}`);
      }

      return { path, bbox: bbox as Bbox };
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
