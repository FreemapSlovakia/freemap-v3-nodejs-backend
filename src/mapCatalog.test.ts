import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  entryProblems,
  fileProblems,
  hostRefusal,
  isCatalogId,
  mapProblems,
} from './catalogRules.mjs';
import { catalogMaps } from './mapCatalog.js';

const read = (file: string) =>
  JSON.parse(
    readFileSync(new URL(`../mapCatalog/${file}`, import.meta.url), 'utf8'),
  );

const ids = read('eli/ids.json') as {
  ids: Record<string, string>;
  retired: Record<string, string>;
};

const curated = read('curated/curatedCatalog.json') as {
  maps: { type: string }[];
};

const curatedTypes = new Set(curated.maps.map((map) => map.type));

test('every map is loaded: none breaks the schema or the catalog rules', () => {
  // Read directly: the module skips what it can't take.
  const eli = read('eli/eliCatalog.json') as { maps: unknown[] };

  assert.ok(eli.maps.length > 0);

  assert.equal(catalogMaps.length, curated.maps.length + eli.maps.length);
});

test('catalog ids: each once', () => {
  const types = catalogMaps.map((map) => map.type);

  assert.equal(new Set(types).size, types.length);
});

test('harvested ids come from the committed table, curated ones never', () => {
  const allocated = new Set(Object.values(ids.ids));

  assert.deepEqual(
    catalogMaps.filter(
      (map) => !curatedTypes.has(map.type) && !allocated.has(map.type),
    ),
    [],
  );

  // The harvest allocates at random and gives a returning map its retired id,
  // so a clash with either is checked rather than ruled out.
  const retired = new Set(Object.values(ids.retired));

  assert.deepEqual(
    [...curatedTypes].filter(
      (type) => allocated.has(type) || retired.has(type),
    ),
    [],
  );
});

test('tile maps have Leaflet templates', () => {
  assert.deepEqual(
    catalogMaps.filter(
      (map) =>
        map.technology !== 'wms' &&
        (!/^(https:)?\/\//.test(map.body.url) ||
          !['{z}', '{x}', '{y}'].every((p) => map.body.url.includes(p))),
    ),
    [],
  );
});

test('curated maps: https only, a tile map without WMS layers', () => {
  assert.deepEqual(
    catalogMaps
      .filter((map) => curatedTypes.has(map.type))
      .filter(
        (map) =>
          !map.body.url.startsWith('https://') ||
          (map.technology !== 'wms' && map.body.layers !== undefined),
      ),
    [],
  );
});

test('every curated map is credited', () => {
  const credited = (map: object) =>
    'body' in map &&
    Array.isArray((map.body as { attribution?: unknown[] }).attribution) &&
    ((map.body as { attribution: unknown[] }).attribution.length ?? 0) > 0;

  assert.deepEqual(
    curated.maps.filter((map) => !credited(map)),
    [],
  );
});

test('the rules refuse what the proxy must not fetch', () => {
  assert.equal(isCatalogId('AB12C'), true);

  assert.equal(isCatalogId('12345'), false);

  assert.equal(isCatalogId('X'), false);

  assert.ok(hostRefusal('10.0.0.1'));

  assert.ok(hostRefusal('[::1]'));

  assert.ok(hostRefusal('backend.freemap.sk.'));

  assert.ok(hostRefusal('localhost'));

  assert.ok(hostRefusal('intranet'));

  assert.ok(hostRefusal('gis.corp.internal'));

  assert.ok(hostRefusal('wms.localhost'));

  assert.equal(hostRefusal('example.com'), undefined);

  const wms = (url: string, layers: unknown[] = ['a']) =>
    mapProblems({ technology: 'wms', body: { url, layers } });

  assert.deepEqual(wms('https://example.com/wms'), []);

  assert.deepEqual(wms('https://example.com/wms?map=/x.map'), []);

  assert.ok(wms('https://example.com/wms?TIME=2024').length);

  assert.ok(wms('http://example.com/wms').length);

  assert.ok(
    mapProblems({ body: { url: 'http://t.example/{z}/{x}/{y}.png' } }).length,
  );

  assert.ok(wms('https://example.com/wms?INFO_FORMAT=text/html').length);

  assert.ok(wms('https://example.com/wms?WIDTH=256').length);

  assert.ok(wms('https://example.com:6379/wms').length);

  assert.deepEqual(wms('https://example.com:443/wms'), []);

  assert.ok(hostRefusal('freemap.bigware.sk'));

  // As the proxy reads them: decoded, any case, dimensions too.
  assert.ok(wms('https://example.com/wms?%72equest=GetMap').length);

  assert.ok(wms('https://example.com/wms?Exceptions=XML').length);

  assert.ok(wms('https://example.com/wms?DIM_BAND=1').length);

  assert.ok(wms('https://example.com/wms', []).length);

  assert.ok(wms('not a url').length);

  // As the proxy uses it: no protocol-relative start or placeholder.
  assert.ok(wms('//example.com/wms').length);

  assert.ok(wms('https://example.com/{x}/wms').length);

  assert.ok(wms('https://example.com/wms', [123]).length);

  assert.ok(
    mapProblems({
      technology: 'wms',
      body: { url: 'https://example.com/wms', layers: ['a'], proxy: 'true' },
    }).length,
  );

  assert.ok(mapProblems({ body: 'x' }).length);

  assert.deepEqual(
    mapProblems({ body: { url: '//tiles.example.com/{z}/{x}/{y}.png' } }),
    [],
  );

  const entry = {
    type: 'AB12C',
    layer: 'overlay',
    name: 'X',
    technology: 'wms',
    body: { url: 'https://example.com/wms', layers: ['a'], attribution: [] },
  };

  assert.deepEqual(entryProblems(entry), []);

  assert.ok(entryProblems({ ...entry, layer: 'Overlay' }).length);

  assert.ok(entryProblems({ ...entry, type: 'x' }).length);

  assert.ok(
    entryProblems({ ...entry, body: { ...entry.body, attribution: undefined } })
      .length,
  );

  assert.deepEqual(fileProblems({ source: 'ELI', maps: [] }), []);

  assert.ok(fileProblems({ maps: null }).length);

  assert.ok(fileProblems({ licence: 3, maps: [] }).length);
});
