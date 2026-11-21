import { find } from 'geo-tz/now';

/**
 * Offline, from the zones' boundary polygons; any zone keeping the place's
 * offsets from now on, so not always its own name (Europe/Paris for Slovakia).
 */
// TODO: off the coast it is a nautical Etc/GMT±N zone, without DST.
export function timeZoneOf(lat: number, lon: number): string | null {
  try {
    return find(lat, lon)[0] ?? null;
  } catch {
    // Its data unreadable: the forecast goes on in the viewer's zone.
    return null;
  }
}
