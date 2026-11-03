import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  opendir,
  readFile,
  rename,
  rmdir,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { RouterInstance } from '@koa/router';
import sharp from 'sharp';
import z from 'zod';
import { getEnv } from '../env.js';
import { appLogger } from '../logger.js';
import { type CatalogMap, catalogMap } from '../mapCatalog.js';
import { registerPath } from '../openapi.js';
import {
  capabilityNames,
  FAILED,
  fetchLimited,
  setParam,
  TOO_LARGE,
  UNREACHABLE_CODES,
  unreachable,
} from './wmsProxyHandler.js';

const logger = appLogger.child({ module: 'wmsTile' });

// A server may render time out of proportion to pixels (the RÚ GeoServer: 0.9 s
// at 256 px, 5 s at 512), so tiles stay small and a HiDPI view asks one zoom
// deeper.
const TILE_SIZE = 256;

// Bounds what can be cached and asked of a third party's server.
export const MAX_ZOOM = 14;

const MAX_LAYERS = 40;

// Renders at once per upstream host; the rest wait their turn. The RÚ GeoServer
// still gains throughput at 16 (3.8 tiles/s against 2 at 4).
const PER_HOST = 16;

// Layer renders, so one cold view of a 10-layer map can bring hundreds.
const MAX_WAITING = 5000;

const MAX_WAIT = 60_000;

const DAY = 24 * 60 * 60 * 1000;

const RETRY_DELAYS = [1000, 3000];

const HALF = 20037508.342789244;

// A transparent 1×1 PNG.
const EMPTY_TILE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAQMAAAAl21bKAAAAA1BMVEVHcEyC+tLSAAAAAXRSTlMAQObYZgAAAApJREFUCNdjYAAAAAIAAeIhvDMAAAAASUVORK5CYII=',
  'base64',
);

// One PNG per map, layer and tile, so any set of layers is composed of them.
const cacheDir = getEnv('WMS_TILE_CACHE_DIR', 'data/wms-tile-cache');

/** A slot per running render, handed on to the next waiting one. */
export class Gate {
  private running = 0;

  private readonly waiting: Array<() => void> = [];

  // Served only when nobody else waits.
  private readonly background: Array<() => void> = [];

  private readonly max: number;

  constructor(max: number) {
    this.max = max;
  }

  /**
   * Whether a slot was had; not when the queue is full, waited out or aborted.
   * `first` jumps the queue, for work already under way; `background` waits
   * behind everyone, without a time limit.
   */
  enter(
    signal: AbortSignal,
    priority: 'first' | 'normal' | 'background' = 'normal',
  ): Promise<boolean> {
    if (signal.aborted) {
      return Promise.resolve(false);
    }

    if (this.running < this.max) {
      this.running++;

      return Promise.resolve(true);
    }

    if (
      priority !== 'first' &&
      this.waiting.length + this.background.length >= MAX_WAITING
    ) {
      return Promise.resolve(false);
    }

    const queue = priority === 'background' ? this.background : this.waiting;

    return new Promise((resolve) => {
      const done = (ok: boolean) => {
        clearTimeout(timer);

        signal.removeEventListener('abort', onAbort);

        const i = queue.indexOf(go);

        if (i !== -1) {
          queue.splice(i, 1);
        }

        resolve(ok);
      };

      // `leave` hands its slot over without counting it free.
      const go = () => done(true);

      const onAbort = () => done(false);

      const timer =
        priority === 'background'
          ? undefined
          : setTimeout(() => done(false), MAX_WAIT);

      signal.addEventListener('abort', onAbort, { once: true });

      if (priority === 'first') {
        queue.unshift(go);
      } else {
        queue.push(go);
      }
    });
  }

  leave() {
    const next = this.waiting.shift() ?? this.background.shift();

    if (next) {
      next();
    } else {
      this.running--;
    }
  }
}

const gates = new Map<string, Gate>();

/** A web-mercator tile's bounds in metres: west, south, east, north. */
export function tileBounds(z: number, x: number, y: number): number[] {
  const size = (2 * HALF) / 2 ** z;

  return [
    -HALF + x * size,
    HALF - (y + 1) * size,
    -HALF + (x + 1) * size,
    HALF - y * size,
  ];
}

const toMercator = (lon: number, lat: number) => [
  (lon * HALF) / 180,
  (Math.log(Math.tan(((90 + lat) * Math.PI) / 360)) * HALF) / Math.PI,
];

/** Whether the tile touches the map's bbox; a map without one covers all. */
export function tileInBbox(
  bbox: CatalogMap['bbox'],
  z: number,
  x: number,
  y: number,
): boolean {
  if (!Array.isArray(bbox) || bbox.length !== 4) {
    return true;
  }

  const [w, s] = toMercator(bbox[0], bbox[1]);

  const [e, n] = toMercator(bbox[2], bbox[3]);

  const [tw, ts, te, tn] = tileBounds(z, x, y);

  return tw < e && te > w && ts < n && tn > s;
}

export function getMapUrl(
  map: CatalogMap,
  layers: string[],
  z: number,
  x: number,
  y: number,
): URL {
  const url = new URL(map.body.url);

  for (const [name, value] of Object.entries({
    SERVICE: 'WMS',
    REQUEST: 'GetMap',
    VERSION: '1.3.0',
    LAYERS: layers.join(','),
    STYLES: '',
    FORMAT: 'image/png',
    TRANSPARENT: 'TRUE',
    CRS: 'EPSG:3857',
    BBOX: tileBounds(z, x, y).join(','),
    WIDTH: String(TILE_SIZE),
    HEIGHT: String(TILE_SIZE),
  })) {
    setParam(url, name, value);
  }

  return url;
}

/**
 * Whether `v` names a map's drawing: the app's drawing version and the map's
 * classes, so a change to either is a new URL rather than a stale cached tile.
 * The version is the app's, any accepted, so the two deploy apart. The app
 * (`Layers.tsx`) and the prerender script write the classes the same way.
 */
export function isTileVersion(v: string, classes: string[] | undefined) {
  const match = /^[1-9]\d{0,2}\.(.*)$/.exec(v);

  return (
    match?.[1] ===
    (classes ?? []).map((c) => c.slice(1).toLowerCase()).join('-')
  );
}

/**
 * The picked layers, or undefined unless the query is exactly the one the app
 * builds: every other spelling would be a cache key of its own.
 */
export function canonicalLayers(
  querystring: string,
  classes: string[] | undefined,
): string[] | undefined {
  const match = /^layers=([^&]*)&v=([^&]*)$/.exec(querystring);

  if (!match || !isTileVersion(match[2], classes)) {
    return undefined;
  }

  let joined;

  try {
    joined = decodeURIComponent(match[1]);
  } catch {
    return undefined;
  }

  const layers = joined.split(',');

  return match[1] === encodeURIComponent(joined) &&
    layers.every(Boolean) &&
    layers.length <= MAX_LAYERS &&
    new Set(layers).size === layers.length
    ? layers
    : undefined;
}

// No leading zeros, so a tile has one URL.
const index = (s: string, below: number) =>
  /^(0|[1-9]\d{0,4})$/.test(s) && Number(s) < below ? Number(s) : undefined;

class QueueFullError extends Error {}

class AbortedError extends Error {}

class NoImageError extends Error {}

// The service URL in the key: a map pointed elsewhere starts afresh.
const layerTilePath = (
  map: CatalogMap,
  layer: string,
  z: number,
  x: number,
  y: number,
) =>
  join(
    cacheDir,
    map.type,
    createHash('sha1').update(`${map.body.url}\n${layer}`).digest('hex'),
    String(z),
    String(x),
    `${y}.png`,
  );

async function isWholeTile(body: Buffer): Promise<boolean> {
  try {
    // The header only; a JPEG labelled PNG would be served as one.
    if ((await sharp(body).metadata()).format !== 'png') {
      return false;
    }

    // Decodes every row, so a truncated one fails here.
    const { info } = await sharp(body)
      .raw()
      .toBuffer({ resolveWithObject: true });

    return info.width === TILE_SIZE && info.height === TILE_SIZE;
  } catch {
    return false;
  }
}

/** A layer's tile and when it was rendered. */
type LayerTile = { body: Buffer; at: number };

async function readFresh(
  path: string,
  days: number,
): Promise<LayerTile | undefined> {
  try {
    const { mtimeMs } = await stat(path);

    return Date.now() - mtimeMs < days * DAY
      ? { body: await readFile(path), at: mtimeMs }
      : undefined;
  } catch {
    return undefined;
  }
}

/** A render shared by every request for the same layer tile. */
type Render = {
  promise: Promise<LayerTile>;
  ac: AbortController;
  waiters: number;
  started: boolean;
  // Queued behind every user's render (the prerender's).
  background: boolean;
};

const renders = new Map<string, Render>();

async function render(
  map: CatalogMap,
  layer: string,
  z: number,
  x: number,
  y: number,
  path: string,
  entry: Render,
): Promise<LayerTile> {
  const url = getMapUrl(map, [layer], z, x, y);

  checkReachable(url);

  let gate = gates.get(url.host);

  if (!gate) {
    gate = new Gate(PER_HOST);

    gates.set(url.host, gate);
  }

  if (
    !(await gate.enter(
      entry.ac.signal,
      entry.background ? 'background' : 'normal',
    ))
  ) {
    throw entry.ac.signal.aborted ? new AbortedError() : new QueueFullError();
  }

  // The last waiter may have left between the slot's handover and now, or the
  // host died while this waited.
  try {
    if (entry.ac.signal.aborted) {
      throw new AbortedError();
    }

    checkReachable(url);
  } catch (err) {
    gate.leave();

    throw err;
  }

  // Started, it finishes for the cache even when nobody waits any more.
  entry.started = true;

  const body = await fetchRetrying(url, gate);

  const tmp = `${path}.${randomUUID()}.tmp`;

  // Twice: the sweep may take an old empty directory between mkdir and write.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await mkdir(dirname(path), { recursive: true });

      await writeFile(tmp, body);

      await rename(tmp, path);

      break;
    } catch (err) {
      await unlink(tmp).catch(() => {
        // Never written.
      });

      if (attempt === 1 || (err as { code?: string }).code !== 'ENOENT') {
        logger.error({ err }, 'WMS tile not cached');

        break;
      }
    }
  }

  return { body, at: Date.now() };
}

function checkReachable(url: URL) {
  if (unreachable.has(url.host)) {
    throw Object.assign(new Error('upstream unreachable'), {
      code: 'EBACKOFF',
    });
  }
}

// Failures load explains; a refused redirect or a dead host are not.
const TRANSIENT_CODES = new Set([
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNABORTED',
  'EPIPE',
]);

/**
 * The tile, asked again after a while when the server failed in a way load
 * explains. Holds a slot of the gate on entry, gives it up while waiting, and
 * takes the next free one back.
 */
async function fetchRetrying(url: URL, gate: Gate): Promise<Buffer> {
  for (let attempt = 0; ; attempt++) {
    if (attempt > 0) {
      await new Promise((resolve) =>
        setTimeout(resolve, RETRY_DELAYS[attempt - 1]),
      );

      checkReachable(url);

      if (!(await gate.enter(new AbortController().signal, 'first'))) {
        throw new QueueFullError();
      }
    }

    const last = attempt === RETRY_DELAYS.length;

    try {
      const answer = await fetchLimited(
        url,
        'getmap',
        undefined,
        /^image\/png\s*(;|$)/i,
      );

      // Decoded before it is kept for days: a cut-off or wrongly sized one
      // would be served, and would break every composition, all that time.
      if (answer.status === 200 && (await isWholeTile(answer.body))) {
        return answer.body;
      }

      // Only the server's own 5xx or 429 is load; `fetchLimited`'s answers (a
      // redirect it didn't follow, too large), an error in XML (415) or a bad
      // image come back the same.
      if (
        last ||
        answer === FAILED ||
        answer === TOO_LARGE ||
        !(answer.status >= 500 || answer.status === 429)
      ) {
        throw new NoImageError(String(answer.status));
      }
    } catch (err) {
      const code = (err as { code?: string }).code ?? '';

      if (UNREACHABLE_CODES.has(code)) {
        unreachable.add(url.host);
      }

      if (last || !TRANSIENT_CODES.has(code)) {
        throw err;
      }
    } finally {
      gate.leave();
    }
  }
}

/** A layer's tile the disk cache lacks, rendered once for all who ask. */
async function layerTile(
  map: CatalogMap,
  layer: string,
  z: number,
  x: number,
  y: number,
  signal: AbortSignal,
  background: boolean,
): Promise<LayerTile> {
  const path = layerTilePath(map, layer, z, x, y);

  // Its listener would never fire, so it would hold the render for good.
  if (signal.aborted) {
    throw new AbortedError();
  }

  let entry = renders.get(path);

  // A user doesn't wait behind the background: that render gives way (its
  // waiters ask again) to one queued as theirs.
  if (entry?.background && !background && !entry.started) {
    entry.ac.abort();

    renders.delete(path);

    entry = undefined;
  }

  if (!entry) {
    const created: Render = {
      promise: Promise.resolve({ body: EMPTY_TILE, at: 0 }),
      ac: new AbortController(),
      waiters: 0,
      started: false,
      background,
    };

    created.promise = render(map, layer, z, x, y, path, created).finally(() => {
      if (renders.get(path) === created) {
        renders.delete(path);
      }
    });

    renders.set(path, created);

    entry = created;
  }

  const shared = entry;

  shared.waiters++;

  // The last one to leave before it started takes it out of the queue, and
  // whoever asks next starts afresh.
  const onAbort = () => {
    if (--shared.waiters === 0 && !shared.started) {
      shared.ac.abort();

      if (renders.get(path) === shared) {
        renders.delete(path);
      }
    }
  };

  signal.addEventListener('abort', onAbort, { once: true });

  try {
    return await shared.promise;
  } finally {
    signal.removeEventListener('abort', onAbort);

    if (!signal.aborted) {
      shared.waiters--;
    }
  }
}

/**
 * Drawn in order, the first at the bottom, as a WMS stacks its `LAYERS`; with
 * `classes`, each pixel's best class of them instead.
 */
async function compose(
  tiles: Buffer[],
  classes: string[] | undefined,
): Promise<Buffer> {
  if (classes) {
    return composeBest(tiles, classes);
  }

  if (tiles.length === 1) {
    return tiles[0];
  }

  return sharp(tiles[0])
    .ensureAlpha()
    .composite(tiles.slice(1).map((input) => ({ input })))
    .png({ palette: true, dither: 0 })
    .toBuffer();
}

// Per channel: a server rounds a colour it draws translucent.
const CLASS_TOLERANCE = 12;

/**
 * Each pixel's best class of `tiles` as opacity in the best class's colour, a
 * legend's pale worse colours being lost over a map: the best opaque, so the
 * map's own opacity alone dims it, the worse evenly fainter, none clear.
 */
export async function composeBest(
  tiles: Buffer[],
  classes: string[],
): Promise<Buffer> {
  const rgb = classes.map((hex) =>
    [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)),
  );

  const best = new Int8Array(TILE_SIZE * TILE_SIZE).fill(-1);

  for (const tile of tiles) {
    const { data } = await sharp(tile)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    for (let p = 0; p < best.length; p++) {
      const i = p * 4;

      if (data[i + 3] === 0) {
        continue;
      }

      // The best first, as it wins anyway.
      for (let c = rgb.length - 1; c > best[p]; c--) {
        if (
          Math.abs(data[i] - rgb[c][0]) <= CLASS_TOLERANCE &&
          Math.abs(data[i + 1] - rgb[c][1]) <= CLASS_TOLERANCE &&
          Math.abs(data[i + 2] - rgb[c][2]) <= CLASS_TOLERANCE
        ) {
          best[p] = c;

          break;
        }
      }
    }
  }

  const [r, g, b] = rgb.at(-1)!;

  const alphas = rgb.map((_, c) => Math.round((255 * (c + 1)) / rgb.length));

  const out = Buffer.alloc(TILE_SIZE * TILE_SIZE * 4);

  for (let p = 0; p < best.length; p++) {
    if (best[p] >= 0) {
      const i = p * 4;

      out[i] = r;

      out[i + 1] = g;

      out[i + 2] = b;

      out[i + 3] = alphas[best[p]];
    }
  }

  return sharp(out, {
    raw: { width: TILE_SIZE, height: TILE_SIZE, channels: 4 },
  })
    .png({ palette: true, dither: 0 })
    .toBuffer();
}

/**
 * Every file under `dir`; a directory left empty and untouched for a day goes
 * once walked (a render that loses one to this writes again).
 */
async function* files(dir: string): AsyncGenerator<string> {
  let handle;

  try {
    handle = await opendir(dir);
  } catch {
    return;
  }

  for await (const entry of handle) {
    const path = join(dir, entry.name);

    if (entry.isDirectory()) {
      yield* files(path);
    } else {
      yield path;
    }
  }

  try {
    if (Date.now() - (await stat(dir)).mtimeMs > DAY) {
      await rmdir(dir);
    }
  } catch {
    // Not empty.
  }
}

/** Drops tiles past their map's days, and every tile of a map no longer cached. */
async function sweep() {
  let removed = 0;

  let types;

  try {
    types = await opendir(cacheDir);
  } catch {
    return;
  }

  for await (const type of types) {
    const map = catalogMap(type.name);

    // Not even listed: more likely a catalog that failed to load than a map
    // gone, and its tiles took hours to render.
    if (!map) {
      continue;
    }

    const days = map.body.tileCache ?? 0;

    for await (const path of files(join(cacheDir, type.name))) {
      // A `.tmp` an hour old was left by a render a restart cut off.
      const keep = path.endsWith('.tmp') ? 60 * 60 * 1000 : days * DAY;

      try {
        if (Date.now() - (await stat(path)).mtimeMs >= keep) {
          await unlink(path);

          removed++;
        }
      } catch {
        // Gone already, or being replaced.
      }
    }
  }

  logger.info({ removed }, 'WMS tile cache swept');
}

export function attachWmsTileHandler(router: RouterInstance) {
  setTimeout(function next() {
    void sweep().finally(() => setTimeout(next, DAY).unref());
  }, 60_000).unref();

  registerPath('/wms-tile/{type}/{z}/{x}/{y}', {
    get: {
      summary: 'A cached tile of a map library WMS',
      description: `For a catalog WMS overlay with \`tileCache\` only: a ${TILE_SIZE} px web-mercator PNG of the picked layers, zoom ${MAX_ZOOM} at most. Each layer's tile is cached for the map's days, so any set is composed of cached ones. The query is exactly \`layers\` then \`v\`: up to ${MAX_LAYERS} layer names of the service's capabilities, in drawing order, joined by commas and encoded as \`encodeURIComponent\` does; and the drawing version, \`<1–999>.<tileClasses without '#', lower-case, joined by '-'>\`.`,
      tags: ['map-library'],
      requestParams: {
        path: z.object({
          type: z.string(),
          z: z.string(),
          x: z.string(),
          y: z.string(),
        }),
        query: z.object({ layers: z.string(), v: z.string() }),
      },
      responses: {
        200: {
          description: "the tile; outside the map's bbox a transparent 1×1 PNG",
        },
        400: {},
        404: { description: 'no cached WMS of the catalog has this id' },
        502: { description: 'unreachable, refused, or not an image' },
        503: { description: 'too many tiles waiting for this server' },
      },
    },
  });

  router.get('/wms-tile/:type/:z/:x/:y', async (ctx) => {
    if (ctx.method === 'HEAD') {
      return ctx.throw(405, 'GET only', { headers: { Allow: 'GET' } });
    }

    // Before any wait, so a tile panned away from is noticed during it.
    const ac = new AbortController();

    ctx.res.once('close', () => ac.abort());

    // The prerender's, past nginx (which sets X-Forwarded-For): it waits
    // behind every user.
    const background =
      ctx.get('x-prerender') === '1' && !ctx.get('x-forwarded-for');

    ctx.set('X-Content-Type-Options', 'nosniff');

    const map = catalogMap(ctx.params.type);

    const days = map?.body.tileCache;

    if (map?.technology !== 'wms' || !days) {
      return ctx.throw(404, 'no cached WMS of the catalog has this id');
    }

    const zoom = index(ctx.params.z, MAX_ZOOM + 1);

    const x = zoom === undefined ? undefined : index(ctx.params.x, 2 ** zoom);

    const y = zoom === undefined ? undefined : index(ctx.params.y, 2 ** zoom);

    if (zoom === undefined || x === undefined || y === undefined) {
      return ctx.throw(400, `no such tile up to zoom ${MAX_ZOOM}`);
    }

    const layers = canonicalLayers(ctx.querystring, map.body.tileClasses);

    if (!layers) {
      return ctx.throw(
        400,
        `only layers, 1 to ${MAX_LAYERS} distinct names encoded once, then v of this map's drawing`,
      );
    }

    const cacheFor = `public, max-age=${(days * DAY) / 1000}`;

    // An image, as an `<img>` takes an empty answer for a failed tile.
    if (!tileInBbox(map.bbox, zoom, x, y)) {
      ctx.set('Content-Type', 'image/png');

      ctx.set('Cache-Control', cacheFor);

      ctx.body = EMPTY_TILE;

      return;
    }

    // A third party's outage, not ours: answered, not thrown. Never cached,
    // nor is an empty answer to a client that went away.
    const fail = (status: number, message?: string) => {
      ctx.status = status;

      ctx.set('Cache-Control', 'no-store');

      if (message) {
        ctx.body = message;
      }
    };

    // A cached tile was rendered for a name checked then, so a set cached whole
    // is served without the capabilities: an outage upstream can't take it down.
    const cached = await Promise.all(
      layers.map((layer) =>
        readFresh(layerTilePath(map, layer, zoom, x, y), days),
      ),
    );

    if (cached.some((tile) => !tile)) {
      // Only names the service has.
      const names = await capabilityNames(map);

      if (!names) {
        return fail(502, 'upstream capabilities unavailable');
      }

      if (layers.some((layer) => !names.has(layer))) {
        return ctx.throw(400, 'a layer the service does not have');
      }
    }

    let body;

    let oldest;

    try {
      const tiles = await Promise.all(
        layers.map(
          (layer, i) =>
            cached[i] ??
            layerTile(map, layer, zoom, x, y, ac.signal, background),
        ),
      );

      oldest = Math.min(...tiles.map((tile) => tile.at));

      body = await compose(
        tiles.map((tile) => tile.body),
        map.body.tileClasses,
      );
    } catch (err) {
      if (ac.signal.aborted) {
        return fail(204);
      }

      if (err instanceof QueueFullError || err instanceof AbortedError) {
        return fail(503, 'too many tiles waiting for this server');
      }

      ctx.log.warn(
        {
          type: map.type,
          code: (err as { code?: string }).code,
          message: (err as Error).message,
        },
        err instanceof NoImageError
          ? 'WMS tile not an image'
          : 'WMS tile failed',
      );

      return fail(502, 'upstream unreachable or refused');
    }

    ctx.set('Content-Type', 'image/png');

    // What is left of its oldest layer's days, so nothing outlives them.
    ctx.set(
      'Cache-Control',
      `public, max-age=${Math.max(0, Math.floor((oldest + days * DAY - Date.now()) / 1000))}`,
    );

    ctx.body = body;
  });
}
