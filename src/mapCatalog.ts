import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import type { RouterInstance } from '@koa/router';
import etag from 'etag';
import z from 'zod';
import { entryProblems, fileProblems } from './catalogRules.mjs';
import { appLogger } from './logger.js';
import { registerPath } from './openapi.js';

/**
 * A map of the app's library catalog, as far as the API reads it; the rest of
 * the app's `CatalogMap` (freemap-v3-react `src/shared/mapLibrary/catalogMap.tsx`)
 * passes through. What it promises is what `entryProblems` checks.
 */
export type CatalogMap = {
  type: string;
  technology?: string;
  layer?: string;
  /** West, south, east, north in degrees. */
  bbox?: [number, number, number, number];
  body: {
    /** Days the proxy's tiles of it are cached; without it, none are served. */
    tileCache?: number;
    /**
     * The colours of its classes, `#rrggbb`, worst first: a tile then shows each
     * pixel's best class of the picked layers as opacity in the best class's
     * colour, and nothing else.
     */
    tileClasses?: string[];
    url: string;
    layers?: string[];
    // The app's hint to go through the proxy straight away; the proxy itself
    // serves every catalog WMS.
    proxy?: boolean;
  };
};

type CatalogFile = { source?: string; licence?: string; maps: CatalogMap[] };

const logger = appLogger.child({ module: 'mapCatalog' });

// A broken file or map costs the library only, not the API's start;
// scripts/check-catalog.mjs keeps one from being deployed.
function read(file: string): CatalogFile {
  let parsed;

  try {
    // build/'s copy (`copy:assets`), so data and code deploy together.
    parsed = JSON.parse(
      readFileSync(new URL(`./mapCatalog/${file}`, import.meta.url), 'utf8'),
    );
  } catch (err) {
    logger.error({ err, file }, 'Map catalog file not loaded');

    return { maps: [] };
  }

  const problems = fileProblems(parsed);

  if (problems.length) {
    logger.error({ file, problems }, 'Map catalog file not loaded');

    return { maps: [] };
  }

  // The catalog's rules hold here too, should a catalog get past the deploy's
  // check: the proxy then never fetches a host they refuse.
  const maps: CatalogMap[] = [];

  const skipped = [];

  for (const map of parsed.maps as unknown[]) {
    const problems = entryProblems(map);

    if (problems.length) {
      skipped.push({
        type: (map as { type?: unknown } | null)?.type,
        problems,
      });
    } else {
      maps.push(map as CatalogMap);
    }
  }

  if (skipped.length) {
    // Which and why, as check-catalog.mjs would say it.
    logger.error({ file, skipped }, 'Map catalog maps skipped');
  }

  return { ...parsed, maps };
}

const curated = read('curated/curatedCatalog.json');

const eli = read('eli/eliCatalog.json');

// Hand-picked maps first, then the harvested ones; see "Harvesting" in the
// app's doc/map-library.md.
// The first of an id wins, so a curated map is never overridden; one list for
// the listing, the lookup and the proxy alike.
const byType = new Map<string, CatalogMap>();

for (const map of [...curated.maps, ...eli.maps]) {
  if (!byType.has(map.type)) {
    byType.set(map.type, map);
  }
}

export const catalogMaps: CatalogMap[] = [...byType.values()];

export const catalogMap = (type: string): CatalogMap | undefined =>
  byType.get(type);

// The whole catalog is large and the same for everyone, so it is encoded once.
// ELI's data is CC BY-SA, so its source and licence travel with it.
const full = Buffer.from(
  JSON.stringify({
    eli: { source: eli.source, licence: eli.licence },
    maps: catalogMaps,
  }),
);

const fullGzip = gzipSync(full);

const fullEtag = etag(full);

const MAX_TYPES = 100;

const QuerySchema = z.object({
  types: z
    .string()
    .optional()
    .meta({ description: 'Comma-separated map ids; all maps when left out' }),
});

export function attachMapCatalogHandler(router: RouterInstance) {
  registerPath('/map-catalog', {
    get: {
      summary: "The map library's catalog: maps users can install",
      tags: ['map-library'],
      requestParams: { query: QuerySchema },
      responses: {
        200: {
          content: {
            'application/json': {
              schema: z.object({
                eli: z
                  .object({
                    source: z.string().optional(),
                    licence: z.string().optional(),
                  })
                  .meta({
                    description:
                      'Where the harvested maps come from, and their licence',
                  }),
                maps: z.array(z.looseObject({ type: z.string() })),
              }),
            },
          },
        },
        304: {},
        400: {},
      },
    },
  });

  router.get('/map-catalog', (ctx) => {
    let query;

    try {
      query = QuerySchema.parse(ctx.query);
    } catch (err) {
      return ctx.throw(400, err as Error);
    }

    // Asked every time, so a deploy's catalog reaches everyone at once; the
    // whole catalog's ETag makes that a cheap 304.
    ctx.set('Cache-Control', 'no-cache');

    if (query.types !== undefined) {
      const types = new Set(query.types.split(','));

      // Refused rather than cut short, which the app would take for ids the
      // catalog lacks; it asks in batches of this many.
      if (types.size > MAX_TYPES) {
        return ctx.throw(400, `at most ${MAX_TYPES} ids`);
      }

      const maps = [...types].flatMap((type) => byType.get(type) ?? []);

      ctx.body = { eli: { source: eli.source, licence: eli.licence }, maps };

      return;
    }

    const gzip = ctx.acceptsEncodings('gzip', 'identity') === 'gzip';

    // A strong ETag differs per content coding.
    ctx.set('ETag', gzip ? `${fullEtag.slice(0, -1)}-gz"` : fullEtag);

    ctx.vary('Accept-Encoding');

    // `fresh` holds only for a 2xx status.
    ctx.status = 200;

    if (ctx.fresh) {
      ctx.status = 304;

      return;
    }

    ctx.type = 'application/json';

    if (gzip) {
      ctx.set('Content-Encoding', 'gzip');
    }

    ctx.body = gzip ? fullGzip : full;
  });
}
