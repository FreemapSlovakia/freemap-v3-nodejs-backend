// Fills the API's WMS tile cache up to `--max-zoom`, a layer per request, so
// any set of layers a user picks there is composed of cached tiles; deeper
// ones (the API serves to 14, which HiDPI asks from map zoom 13) render on
// first view. Run on fm6 against the API itself, past nginx, which would only
// cache these one-layer sets. Re-running skips what is cached, so it can be
// stopped and resumed.
//
//   node scripts/prerender-wms-tiles.mjs [--base http://localhost:3000]
//     [--max-zoom 13] [--concurrency 8] FSK18 FSK19 …
//
// Each map's own layers are rendered, within its bbox.
import { parseArgs } from 'node:util';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    base: { type: 'string', default: 'http://localhost:3000' },
    'max-zoom': { type: 'string', default: '13' },
    // Leaves the API's other slots per upstream host to users.
    concurrency: { type: 'string', default: '8' },
  },
});

const maxZoom = Number(values['max-zoom']);

const concurrency = Number(values.concurrency);

if (!positionals.length || !(maxZoom >= 0) || !(concurrency >= 1)) {
  console.error(
    'usage: prerender-wms-tiles.mjs [--base URL] [--max-zoom N] [--concurrency N] TYPE…',
  );

  process.exit(1);
}

const res = await fetch(
  `${values.base}/map-catalog?types=${positionals.join(',')}`,
);

if (!res.ok) {
  throw new Error(`catalog: ${res.status}`);
}

const { maps } = await res.json();

// Clamped into the grid: a bbox may reach the antimeridian or past the
// projection's latitude.
const clamp = (i, z) => Math.min(Math.max(i, 0), 2 ** z - 1);

const lon2x = (lon, z) => clamp(Math.floor(((lon + 180) / 360) * 2 ** z), z);

const lat2y = (lat, z) => {
  const r = (Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI) / 180;

  return clamp(
    Math.floor(
      ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z,
    ),
    z,
  );
};

/** Each URL to ask, low zooms first. */
function* urls() {
  for (let z = 0; z <= maxZoom; z++) {
    for (const map of maps) {
      if (
        !map.body?.tileCache ||
        !Array.isArray(map.bbox) ||
        !Array.isArray(map.body.layers)
      ) {
        continue;
      }

      const [w, s, e, n] = map.bbox;

      // Any drawing version fills the same layer tiles.
      const v = `1.${(map.body.tileClasses ?? []).map((c) => c.slice(1).toLowerCase()).join('-')}`;

      for (let x = lon2x(w, z); x <= lon2x(e, z); x++) {
        for (let y = lat2y(n, z); y <= lat2y(s, z); y++) {
          for (const layer of map.body.layers) {
            yield `${values.base}/wms-tile/${map.type}/${z}/${x}/${y}?layers=${encodeURIComponent(layer)}&v=${v}`;
          }
        }
      }
    }
  }
}

const missing = positionals.filter(
  (type) => !maps.some((map) => map.type === type && map.body?.tileCache),
);

if (missing.length) {
  console.error(`not cached maps of the catalog: ${missing.join(', ')}`);

  process.exit(1);
}

const total = [...urls()].length;

let done = 0;

let failed = 0;

const started = Date.now();

const queue = urls();

async function worker() {
  for (const url of queue) {
    for (let attempt = 1; ; attempt++) {
      const res = await fetch(url).catch((err) => ({ ok: false, err }));

      // Read whatever came, so the connection is free again.
      await res.arrayBuffer?.().catch(() => undefined);

      if (res.ok) {
        break;
      }

      // A busy or slow upstream: wait and ask again, a few times. A 4xx is a
      // request that will fail the same way.
      if (attempt === 3 || (res.status >= 400 && res.status < 500)) {
        failed++;

        console.error(`failed: ${url} (${res.status ?? res.err})`);

        break;
      }

      await new Promise((resolve) => setTimeout(resolve, attempt * 10_000));
    }

    if (++done % 500 === 0 || done === total) {
      const rate = done / ((Date.now() - started) / 1000);

      console.log(
        `${done}/${total} (${failed} failed), ${rate.toFixed(1)}/s, ~${Math.round((total - done) / rate / 60)} min left`,
      );
    }
  }
}

await Promise.all(Array.from({ length: concurrency }, worker));
