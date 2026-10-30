// The map catalog's rules, the one copy: the harvest drops a map that breaks
// them, check-catalog.mjs refuses a deploy with one, and the API skips one at
// load. Plain JS, so the scripts read it before any build.
import { isIP } from 'node:net';

/**
 * Five uppercase letters or digits, one a letter: never a built-in's id.
 * @param {unknown} id
 * @returns {boolean}
 */
export const isCatalogId = (id) =>
  typeof id === 'string' && /^[0-9A-Z]{5}$/.test(id) && /[A-Z]/.test(id);

/**
 * A map's URL parsed: a tile template's placeholders and a protocol-relative
 * start made parseable; a WMS URL as it stands, as the proxy uses it.
 * @param {string} url
 * @param {boolean} wms
 * @returns {URL | undefined}
 */
export function parseMapUrl(url, wms) {
  try {
    return new URL(
      wms ? url : url.replace(/\{[^}]*\}/g, 'x').replace(/^\/\//, 'https://'),
    );
  } catch {
    return undefined;
  }
}

/**
 * Why the proxy mustn't fetch from this host, or undefined.
 * @param {string} hostname
 * @returns {string | undefined}
 */
export function hostRefusal(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');

  if (isIP(host)) {
    return 'an IP address, not a name';
  }

  // `localhost` and other single-label names are someone's local network.
  if (
    !host.includes('.') ||
    /\.(localhost|local|internal|lan|home\.arpa)$/i.test(host)
  ) {
    return 'not a public name';
  }

  // Built in, and trusted by our own servers (the API's CORS list has them).
  if (/(^|\.)freemap\.(sk|eu|cz)$|^freemap\.bigware\.sk$/i.test(host)) {
    return 'served by Freemap itself';
  }

  return undefined;
}

// The WMS parameters the app sets on each request and the proxy passes on;
// one in a catalog map's base URL would win over the app's.
const FORWARDED_PARAMS = new Set([
  'service',
  'request',
  'version',
  'layers',
  'query_layers',
  'styles',
  'crs',
  'srs',
  'bbox',
  'width',
  'height',
  'i',
  'j',
  'x',
  'y',
  'info_format',
  'feature_count',
  'format',
  'exceptions',
  'transparent',
  'time',
  'elevation',
]);

/**
 * Whether the proxy passes this parameter on (lower-cased): a standard one or
 * a dimension (`dim_*`).
 * @param {string} name
 * @returns {boolean}
 */
export const isForwardedParam = (name) =>
  FORWARDED_PARAMS.has(name) || name.startsWith('dim_');

const isObject = (v) =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * What a map breaks of what the API, the proxy and an https page rely on; its
 * id aside, which the harvest gives it last (`isCatalogId`).
 * @param {unknown} map
 * @returns {string[]}
 */
export function mapProblems(map) {
  if (!isObject(map) || !isObject(map.body)) {
    return ['not a map with a body'];
  }

  const { technology, body } = map;

  const problems = [];

  if (technology !== undefined && typeof technology !== 'string') {
    problems.push('technology not a string');
  }

  if (body.proxy !== undefined && typeof body.proxy !== 'boolean') {
    problems.push('proxy not a boolean');
  }

  const { layers, url } = body;

  if (
    layers !== undefined &&
    (!Array.isArray(layers) || layers.some((l) => typeof l !== 'string'))
  ) {
    problems.push('layers not a list of names');
  }

  if (typeof url !== 'string') {
    return [...problems, 'no body.url'];
  }

  const wms = technology === 'wms';

  const parsed = parseMapUrl(url, wms);

  if (!parsed) {
    return [...problems, "URL doesn't parse"];
  }

  const refusal = hostRefusal(parsed.hostname);

  if (refusal) {
    problems.push(refusal);
  }

  // An https page can't load it; protocol-relative (`//`) takes the page's.
  if (/^http:/i.test(url)) {
    problems.push('plain http');
  }

  if (wms) {
    if (parsed.protocol !== 'https:') {
      problems.push('WMS not on https');
    }

    // The proxy connects to it: no other port of a third party's host.
    if (parsed.port && parsed.port !== '443') {
      problems.push('WMS on a port other than 443');
    }

    if (/\{[^}]*\}/.test(url)) {
      problems.push('WMS URL with a placeholder');
    }

    if (body.wmts !== undefined) {
      const wmts =
        typeof body.wmts === 'string' &&
        body.wmts.includes('{layer}') &&
        parseMapUrl(body.wmts, false);

      if (!wmts) {
        problems.push("WMTS template doesn't parse");
      } else if (wmts.protocol !== 'https:' || /^\/\//.test(body.wmts)) {
        problems.push('WMTS not on https');
      } else {
        const wmtsRefusal = hostRefusal(wmts.hostname);

        if (wmtsRefusal) {
          problems.push(`WMTS ${wmtsRefusal}`);
        }
      }
    }

    // Decoded, as the proxy reads them.
    if (
      [...parsed.searchParams.keys()].some((k) =>
        isForwardedParam(k.toLowerCase()),
      )
    ) {
      problems.push('WMS URL with request parameters');
    }

    if (!Array.isArray(layers) || !layers.length) {
      problems.push('WMS without layers');
    }
  }

  return problems;
}

/**
 * What a finished catalog entry breaks: its id, what the app needs of it (its
 * `CatalogMapSchema`) and `mapProblems`. For the deploy's check and the API's
 * load; the harvest checks `mapProblems` before it has built the rest.
 * @param {unknown} map
 * @returns {string[]}
 */
export function entryProblems(map) {
  const problems = mapProblems(map);

  if (!isObject(map)) {
    return problems;
  }

  if (!isCatalogId(map.type)) {
    problems.push('bad id');
  }

  if (map.layer !== 'base' && map.layer !== 'overlay') {
    problems.push('layer neither base nor overlay');
  }

  if (typeof map.name !== 'string') {
    problems.push('no name');
  }

  if (isObject(map.body) && !Array.isArray(map.body.attribution)) {
    problems.push('no attribution list');
  }

  return problems;
}

/**
 * What a catalog file breaks of its shape, its maps aside.
 * @param {unknown} file
 * @returns {string[]}
 */
export function fileProblems(file) {
  if (!isObject(file) || !Array.isArray(file.maps)) {
    return ['no maps list'];
  }

  return ['source', 'licence'].flatMap((key) =>
    file[key] !== undefined && typeof file[key] !== 'string'
      ? [`${key} not a string`]
      : [],
  );
}
