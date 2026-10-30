import { lookup } from 'node:dns';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import type { RouterInstance } from '@koa/router';
import got from 'got';
import z from 'zod';
import { isForwardedParam } from '../catalogRules.mjs';
import { appLogger } from '../logger.js';
import { type CatalogMap, catalogMap } from '../mapCatalog.js';
import { registerPath } from '../openapi.js';

const logger = appLogger.child({ module: 'wmsProxy' });

// Only what a browser must read; GetMap images and legends need no CORS.
const ALLOWED_REQUESTS = new Set(['getcapabilities', 'getfeatureinfo']);

// GML is `application/vnd.ogc.gml` (GML 3 adds `/3.1.1`), which names no xml
// suffix. Anchored, so a type merely containing `xml` doesn't pass.
export const ALLOWED_TYPES =
  /^(text\/(xml|html|plain)|application\/([\w.+-]*xml|[\w.+-]*json|vnd\.ogc\.[\w.+/-]+))\s*(;|$)/i;

const MAX_BYTES = 10 * 1024 * 1024;

// Upstream fetches at once for each kind (capabilities, feature info), so
// parallel calls can't pile up buffers.
const MAX_PER_KIND = 8;

// Dimensions passed on with one feature-info request, so it stays bounded.
const MAX_DIMENSIONS = 8;

const CAPABILITIES_TTL = 24 * 60 * 60 * 1000;

const CACHE_MAX_BYTES = 64 * 1024 * 1024;

const nonPublic = new BlockList();

for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  // Documentation and 6to4 relay ranges: unrouted publicly, so anything there
  // is someone's internal network.
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 3],
] as const) {
  nonPublic.addSubnet(net, prefix, 'ipv4');
}

for (const [net, prefix] of [
  // No ::ffff:0:0/96: BlockList checks IPv4-mapped addresses against the IPv4
  // rules, and that subnet would match every IPv4 address.
  ['::', 96],
  ['::ffff:0:0:0', 96],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 32],
  ['2001:db8::', 32],
  ['2001:10::', 28],
  ['2001:20::', 28],
  ['3fff::', 20],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
] as const) {
  nonPublic.addSubnet(net, prefix, 'ipv6');
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);

  return (
    family !== 0 && !nonPublic.check(address, family === 4 ? 'ipv4' : 'ipv6')
  );
}

/** Lower-cased values of a parameter, its name matched case-insensitively. */
const values = (params: URLSearchParams, name: string) =>
  [...params]
    .filter(([key]) => key.toLowerCase() === name)
    .map(([, value]) => value.toLowerCase());

/** The WMS request, lower-cased, or undefined unless one allowed request is asked. */
export function wmsRequest(params: URLSearchParams): string | undefined {
  // One of each only: servers differ in which of several they obey.
  const services = values(params, 'service');

  const requests = values(params, 'request');

  return services.length === 1 &&
    services[0] === 'wms' &&
    requests.length === 1 &&
    ALLOWED_REQUESTS.has(requests[0])
    ? requests[0]
    : undefined;
}

/**
 * The upstream request: the catalog map's service URL, which keeps its own
 * parameters, plus the client's. Capabilities take only SERVICE, REQUEST and
 * VERSION, so junk parameters can't defeat the cache.
 */
export function upstreamUrl(
  map: CatalogMap,
  params: URLSearchParams,
  request: string,
): URL {
  const url = new URL(map.body.url);

  // Written out rather than copied, so one document has one URL and cache key.
  if (request === 'getcapabilities') {
    const version = values(params, 'version')[0];

    // Names are case-insensitive to WMS, not to `set`.
    const set = (name: string, value: string) => {
      for (const key of [...url.searchParams.keys()]) {
        if (key.toLowerCase() === name.toLowerCase()) {
          url.searchParams.delete(key);
        }
      }

      url.searchParams.set(name, value);
    };

    set('SERVICE', 'WMS');

    set('REQUEST', 'GetCapabilities');

    set(
      'VERSION',
      version === '1.1.1' || version === '1.1.0' ? version : '1.3.0',
    );

    return url;
  }

  const own = new Set([...url.searchParams.keys()].map((k) => k.toLowerCase()));

  let dimensions = 0;

  // Standard ones only (dimensions too: one the map draws must be asked):
  // vendor parameters (MapServer's map, SLD, GeoServer's env) would reach the
  // server as our request. One of each, whatever its case, as servers differ
  // in which of several they obey.
  for (const [key, value] of params) {
    const k = key.toLowerCase();

    const dimension = k.startsWith('dim_');

    if (
      isForwardedParam(k) &&
      !own.has(k) &&
      (!dimension || dimensions < MAX_DIMENSIONS)
    ) {
      url.searchParams.append(key, value);

      own.add(k);

      if (dimension) {
        dimensions++;
      }
    }
  }

  return url;
}

const portOf = (url: URL) =>
  url.port || (url.protocol === 'https:' ? '443' : '80');

/** Whether a redirect stays on the service: same origin, path and request. */
export function redirectAllowed(from: URL, to: URL, request: string): boolean {
  const path = (url: URL) => url.pathname.replace(/\/$/, '');

  return (
    to.hostname === from.hostname &&
    to.protocol === from.protocol &&
    portOf(to) === portOf(from) &&
    path(to) === path(from) &&
    wmsRequest(to.searchParams) === request
  );
}

// Resolves as usual but keeps public addresses only, so the check covers the
// address actually connected to, on every redirect too.
const publicLookup = ((hostname, options, callback) => {
  lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) {
      callback(err, '', 0);
      return;
    }

    // The public ones only: the socket connects to nothing else, so a stray
    // private record doesn't make the whole host unreachable.
    const good = addresses.filter((a) => isPublicAddress(a.address));

    if (!good.length) {
      callback(
        Object.assign(new Error(`${hostname} is not a public address`), {
          code: 'ENOTPUBLIC',
        }),
        '',
        0,
      );

      return;
    }

    if (options.all) {
      (callback as (e: null, a: typeof good) => void)(null, good);
    } else {
      callback(null, good[0].address, good[0].family);
    }
  });
}) as LookupFunction;

type Answer = { status: number; type: string; body: Buffer };

const cache = new Map<string, { answer: Answer; expires: number }>();

let cacheBytes = 0;

function forget(key: string) {
  const entry = cache.get(key);

  if (entry) {
    cache.delete(key);

    cacheBytes -= entry.answer.body.length;
  }
}

function remember(key: string, answer: Answer) {
  forget(key);

  // Oldest first, as a Map iterates in insertion order.
  for (const k of cache.keys()) {
    if (cacheBytes + answer.body.length <= CACHE_MAX_BYTES) {
      break;
    }

    forget(k);
  }

  cache.set(key, { answer, expires: Date.now() + CAPABILITIES_TTL });

  cacheBytes += answer.body.length;
}

function cached(key: string): Answer | undefined {
  const entry = cache.get(key);

  if (!entry) {
    return undefined;
  }

  forget(key);

  if (entry.expires < Date.now()) {
    return undefined;
  }

  // Back to the end, so eviction takes the least recently used.
  cache.set(key, entry);

  cacheBytes += entry.answer.body.length;

  return entry.answer;
}

/** The start of a body as text, by its byte-order mark, the mark dropped. */
function headText(body: Buffer): string {
  const head = body.subarray(0, 65536);

  if (head[0] === 0xff && head[1] === 0xfe) {
    return head.subarray(2).toString('utf16le');
  }

  if (head[0] === 0xfe && head[1] === 0xff) {
    return Buffer.from(head.subarray(2, head.length & ~1))
      .swap16()
      .toString('utf16le');
  }

  if (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) {
    return head.subarray(3).toString('latin1');
  }

  return head.toString('latin1');
}

/**
 * The name of a document's root element, past the prolog, comments and a
 * doctype. A scan, not one regex, which would backtrack exponentially on a
 * run of comments.
 */
export function rootElement(text: string): string | undefined {
  let i = 0;

  for (;;) {
    while (/\s/.test(text[i] ?? '')) {
      i++;
    }

    if (text.startsWith('<?', i)) {
      i = text.indexOf('?>', i);
    } else if (text.startsWith('<!--', i)) {
      i = text.indexOf('-->', i);
    } else if (text.startsWith('<!DOCTYPE', i)) {
      // An internal subset in brackets may hold `>` of its own.
      const bracket = text.indexOf('[', i);

      const end = text.indexOf('>', i);

      if (bracket !== -1 && (end === -1 || bracket < end)) {
        const close = text.indexOf(']', bracket);

        i = close === -1 ? -1 : text.indexOf('>', close);
      } else {
        i = end;
      }
    } else {
      return /^<([\w:.-]+)/.exec(text.slice(i))?.[1];
    }

    if (i === -1) {
      return undefined;
    }

    // Past the `>` that ends the `?>`, `-->` or doctype just found; each
    // found index is at or after `i`, so the scan only moves forward.
    i = text.indexOf('>', i) + 1;
  }
}

// Servers answer errors and login pages with 200 too; only these are kept.
export function isCapabilities(answer: Answer): boolean {
  return (
    answer.status === 200 &&
    /^(\w+:)?(WMS_Capabilities|WMT_MS_Capabilities)$/.test(
      rootElement(headText(answer.body)) ?? '',
    )
  );
}

class BusyError extends Error {}

/** Keys that just failed, for a while: a dead service isn't asked again by every user. */
export class Backoff {
  private readonly until = new Map<string, number>();

  private readonly ttl: number;

  constructor(ttl: number) {
    this.ttl = ttl;
  }

  has(key: string): boolean {
    const until = this.until.get(key);

    if (until !== undefined && until <= Date.now()) {
      this.until.delete(key);
    }

    return this.until.has(key);
  }

  add(key: string) {
    this.until.set(key, Date.now() + this.ttl);
  }
}

// By upstream host, which maps share: each request to a dead server, for
// capabilities or feature info, would otherwise wait out the timeout.
const unreachable = new Backoff(60 * 1000);

const UNREACHABLE_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTPUBLIC',
]);

// By capabilities URL: each asks up to 30 s and 10 MB.
const capabilitiesFailed = new Backoff(5 * 60 * 1000);

const FAILED: Answer = {
  status: 502,
  type: 'text/plain',
  body: Buffer.from('upstream unreachable or refused'),
};

// Per kind, so slow capabilities downloads can't starve map clicks.
const running = { getcapabilities: 0, getfeatureinfo: 0 };

async function fetchUpstream(
  url: URL,
  request: string,
  signal?: AbortSignal,
): Promise<Answer> {
  const kind =
    request === 'getcapabilities' ? 'getcapabilities' : 'getfeatureinfo';

  if (running[kind] >= MAX_PER_KIND) {
    throw new BusyError();
  }

  running[kind]++;

  try {
    return await fetchLimited(url, request, signal);
  } finally {
    running[kind]--;
  }
}

async function fetchLimited(
  url: URL,
  request: string,
  signal?: AbortSignal,
): Promise<Answer> {
  const stream = got.stream(url, {
    dnsLookup: publicLookup,
    throwHttpErrors: false,
    // Capabilities can be large and slow; feature info holds up a click.
    timeout: { request: request === 'getcapabilities' ? 30_000 : 10_000 },
    headers: { 'user-agent': 'Freemap WMS proxy (https://www.freemap.sk/)' },
    maxRedirects: 5,
    signal,
    hooks: {
      beforeRedirect: [
        (options) => {
          if (!redirectAllowed(url, new URL(String(options.url)), request)) {
            throw new Error('redirect refused');
          }
        },
      ],
    },
  });

  stream.on('error', () => {
    // A second error (after a destroy or an abort) would otherwise have no
    // listener and crash the process; the waits below see their own.
  });

  const response = await new Promise<{
    statusCode: number;
    headers: Record<string, string | string[] | undefined>;
  }>((resolve, reject) => {
    stream.once('response', resolve);

    stream.once('error', reject);
  });

  const type = String(response.headers['content-type'] ?? '');

  const { statusCode } = response;

  // No content (no features there) carries no type to judge.
  if (statusCode === 204) {
    stream.destroy();

    return { status: 204, type: 'text/plain', body: Buffer.alloc(0) };
  }

  // A redirect got didn't follow has nothing the browser could use.
  if (statusCode >= 300 && statusCode < 400) {
    stream.destroy();

    return FAILED;
  }

  // Capabilities are judged by their body (`isCapabilities`), as some servers
  // label them octet-stream or not at all, and are then served as XML.
  if (request !== 'getcapabilities' && !ALLOWED_TYPES.test(type)) {
    stream.destroy();

    const ok = statusCode >= 200 && statusCode < 300;

    // A server error stays one; 415 for an answer of the wrong type only, on
    // which the client tries its next INFO_FORMAT.
    return {
      status: ok ? 415 : statusCode,
      type: 'text/plain',
      body: Buffer.from(
        ok ? `unexpected content type: ${type || 'none'}` : 'upstream error',
      ),
    };
  }

  // Announced too large: refused before downloading what can't be kept.
  if (Number(response.headers['content-length']) > MAX_BYTES) {
    stream.destroy();

    return {
      status: 502,
      type: 'text/plain',
      body: Buffer.from('response too large'),
    };
  }

  const chunks: Buffer[] = [];

  let size = 0;

  for await (const chunk of stream) {
    size += chunk.length;

    if (size > MAX_BYTES) {
      stream.destroy();

      return {
        status: 502,
        type: 'text/plain',
        body: Buffer.from('response too large'),
      };
    }

    chunks.push(chunk);
  }

  return {
    status: response.statusCode,
    // Capabilities as XML, keeping a charset the upstream declared.
    type:
      request === 'getcapabilities'
        ? `text/xml${/;\s*charset=[^;]+/i.exec(type)?.[0] ?? ''}`
        : type,
    body: Buffer.concat(chunks),
  };
}

// Capabilities being fetched, so simultaneous misses share one download.
const inFlight = new Map<string, Promise<{ answer: Answer; kept: boolean }>>();

function fetchCapabilities(
  key: string,
  url: URL,
  type: string,
): Promise<{ answer: Answer; kept: boolean }> {
  if (capabilitiesFailed.has(key)) {
    return Promise.resolve({ answer: FAILED, kept: false });
  }

  let p = inFlight.get(key);

  if (!p) {
    p = fetchUpstream(url, 'getcapabilities')
      .then(
        (answer) => {
          if (isCapabilities(answer)) {
            remember(key, answer);

            return { answer, kept: true };
          }

          // What the backoff answers for 5 minutes, so a broken service can be
          // found: by its host, as maps may share one.
          logger.warn(
            {
              type,
              host: url.host,
              status: answer.status,
              contentType: answer.type,
            },
            'WMS capabilities not a capabilities document',
          );

          capabilitiesFailed.add(key);

          // An error page is answered as the later callers get it.
          return { answer: FAILED, kept: false };
        },
        (err: unknown) => {
          if (!(err instanceof BusyError)) {
            capabilitiesFailed.add(key);
          }

          throw err;
        },
      )
      .finally(() => inFlight.delete(key));

    inFlight.set(key, p);
  }

  return p;
}

export function attachWmsProxyHandler(router: RouterInstance) {
  registerPath('/wms-proxy/{type}', {
    get: {
      summary:
        'Ask a map library WMS for what a browser must read, for a server that sends no CORS',
      description:
        "`type` is a catalog map's id. The query is the WMS request's own: one SERVICE=WMS and one REQUEST, GetCapabilities or GetFeatureInfo; the service URL comes from the catalog. Capabilities are cached for a day.",
      tags: ['maps'],
      requestParams: { path: z.object({ type: z.string() }) },
      responses: {
        200: { description: 'the upstream answer, its status passed through' },
        400: {},
        404: { description: 'no WMS of the catalog has this id' },
        415: { description: 'the upstream answered with a disallowed type' },
        502: { description: 'unreachable, refused, or too large an answer' },
        503: { description: 'too many requests in progress' },
      },
    },
  });

  router.get('/wms-proxy/:type', async (ctx) => {
    // The router answers HEAD here too; it would fetch upstream for nothing.
    if (ctx.method === 'HEAD') {
      return ctx.throw(405, 'GET only', { headers: { Allow: 'GET' } });
    }

    // Never rendered as a page of ours, whatever is answered.
    ctx.set('Content-Security-Policy', "default-src 'none'; sandbox");

    ctx.set('X-Content-Type-Options', 'nosniff');

    const map = catalogMap(ctx.params.type);

    if (map?.technology !== 'wms') {
      return ctx.throw(404, 'no WMS of the catalog has this id');
    }

    const params = new URLSearchParams(ctx.querystring);

    const request = wmsRequest(params);

    if (!request) {
      return ctx.throw(
        400,
        'only one SERVICE=WMS and GetCapabilities or GetFeatureInfo',
      );
    }

    // A third party's outage, not ours: answered, not thrown, so Sentry stays quiet.
    const fail = (status: number, message: string) => {
      ctx.status = status;

      ctx.set('Cache-Control', 'no-store');

      ctx.body = message;
    };

    // Parses and names no IP address: the catalog's rules held at load.
    const url = upstreamUrl(map, params, request);

    const capabilities = request === 'getcapabilities';

    // A shared capabilities download outlives the client that started it.
    const ac = new AbortController();

    if (!capabilities) {
      ctx.res.once('close', () => ac.abort());
    }

    let answer;

    let kept = false;

    try {
      const hit = capabilities ? cached(url.toString()) : undefined;

      if (hit) {
        answer = hit;

        kept = true;
      } else if (unreachable.has(url.host)) {
        return fail(502, 'upstream unreachable or refused');
      } else if (capabilities) {
        ({ answer, kept } = await fetchCapabilities(
          url.toString(),
          url,
          map.type,
        ));
      } else {
        answer = await fetchUpstream(url, request, ac.signal);
      }
    } catch (err) {
      if (err instanceof BusyError) {
        return fail(503, 'too many requests in progress');
      }

      // The client went away: nothing to answer, and no 404 in the logs.
      if (ac.signal.aborted) {
        ctx.status = 204;

        return;
      }

      // Only a server that can't be reached at all, not one slow query.
      if (UNREACHABLE_CODES.has((err as { code?: string }).code ?? '')) {
        unreachable.add(url.host);
      }

      // Not the error object: got's carries the request URL.
      ctx.log.warn(
        {
          type: map.type,
          code: (err as { code?: string }).code,
          message: (err as Error).message,
        },
        'WMS proxy failed',
      );

      return fail(502, 'upstream unreachable or refused');
    }

    ctx.status = answer.status;

    // Set as is: ctx.type would add a charset the upstream didn't declare.
    ctx.set('Content-Type', answer.type);

    ctx.set('Cache-Control', kept ? 'public, max-age=3600' : 'no-store');

    ctx.body = answer.body;
  });
}
