import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import gdal from 'gdal-async';
import {
  type Bbox,
  createInverseProjector,
  createProjector,
  datasetBbox,
  inBbox,
  loadElevationSources,
  mergeCredits,
  parseSourceJson,
  srtmKey,
} from './elevationHelpers.js';

test('createProjector: applies the datum shift a proj4 string would drop', () => {
  // Charing Cross in OSGB36 / British National Grid. Going through
  // `toProj4()` loses the OSGB36 datum transformation and lands ~113 m west,
  // near 529916 — which is what silently misread every English sample.
  const project = createProjector(gdal.SpatialReference.fromEPSG(27700));

  assert.ok(project);

  const { x, y } = project(-0.1278, 51.5074);

  assert.ok(
    Math.abs(x - 530029) < 25,
    `easting ${x} is not within 25 m of 530029 — datum shift lost?`,
  );

  assert.ok(
    Math.abs(y - 180380) < 25,
    `northing ${y} is not within 25 m of 180380 — datum shift lost?`,
  );
});

test('createProjector: undoes northing-first axis order', () => {
  // EPSG:3035 (ETRS89-LAEA) declares northing first, so the raw
  // transformPoint hands back (y, x); the projector must report (x, y).
  const project = createProjector(gdal.SpatialReference.fromEPSG(3035));

  assert.ok(project);

  const { x, y } = project(10, 50);

  assert.ok(Math.abs(x - 4321000) < 25, `easting ${x} looks like a northing`);
  assert.ok(Math.abs(y - 2987511) < 25, `northing ${y} looks like an easting`);
});

test('createProjector: undoes lat-first axis order of geographic EPSG:4326', () => {
  // GEDTM30 carries a plain EPSG:4326 SRS, whose authority axis order is
  // lat/lon. Feeding the raw transformPoint output to the geotransform read
  // the wrong continent (Fruska Gora came back as 702 m, an Arabian plateau).
  const project = createProjector(gdal.SpatialReference.fromEPSG(4326));

  assert.ok(project);

  const { x, y } = project(19.851715564727787, 45.16161498912903);

  assert.ok(Math.abs(x - 19.851715564727787) < 1e-9, `x ${x} is a latitude`);
  assert.ok(Math.abs(y - 45.16161498912903) < 1e-9, `y ${y} is a longitude`);
});

test('createProjector: null for a dataset already in lon/lat', () => {
  assert.equal(createProjector(null), null);
});

test('srtmKey: northern/eastern coordinates', () => {
  assert.equal(srtmKey(48.14, 17.11), 'N48E017');
  assert.equal(srtmKey(0, 0), 'N00E000');
});

test('srtmKey: southern latitude uses S, not E', () => {
  assert.equal(srtmKey(-10.5, 20.3), 'S11E020');
  assert.equal(srtmKey(-0.1, 0.1), 'S01E000');
});

test('srtmKey: western longitude uses W', () => {
  assert.equal(srtmKey(48.14, -120.5), 'N48W121');
});

test('inBbox: inclusive bounds', () => {
  const bbox: Bbox = [16.8, 47.7, 22.6, 49.7];

  assert.equal(inBbox(bbox, 48.14, 17.11), true);
  assert.equal(inBbox(bbox, 47.7, 16.8), true); // on the corner
  assert.equal(inBbox(bbox, 48.21, 16.37), false); // west of bbox
  assert.equal(inBbox(bbox, 50, 20), false); // north of bbox
});

test('parseSourceJson: name, file and attributions', () => {
  const src = parseSourceJson(
    JSON.stringify({
      name: 'sonny',
      file: 'de.tif',
      attributions: [
        { name: "Sonny's LiDAR DTM", url: 'https://sonny.4lima.de/' },
      ],
    }),
    '/dtm/700-sonny-de',
  );

  assert.equal(src.name, 'sonny');
  assert.equal(src.path, '/dtm/700-sonny-de/de.tif');
  assert.equal(src.bbox, undefined);
  assert.deepEqual(src.attributions, [
    { name: "Sonny's LiDAR DTM", url: 'https://sonny.4lima.de/' },
  ]);
});

test('parseSourceJson: an absolute file is left where it is', () => {
  // So a source can be described without moving the raster it points at.
  const src = parseSourceJson(
    JSON.stringify({ name: 'sk', file: '/fm/storage1/dmr5.tif' }),
    '/dtm/010-sk',
  );

  assert.equal(src.path, '/fm/storage1/dmr5.tif');
  assert.deepEqual(src.attributions, []);
});

test('parseSourceJson: several credits under one name', () => {
  // Belgium is two models under two licences, both of which must be shown.
  const src = parseSourceJson(
    JSON.stringify({
      name: 'be',
      file: 'be.vrt',
      attributions: [{ name: 'SPW', url: 'http://spw/' }, { name: 'DHMV II' }],
    }),
    '/dtm/160-be',
  );

  assert.deepEqual(src.attributions, [
    { name: 'SPW', url: 'http://spw/' },
    { name: 'DHMV II' },
  ]);
});

test('parseSourceJson: a pinned bbox is kept', () => {
  const src = parseSourceJson(
    JSON.stringify({ name: 'x', file: 'x.tif', bbox: [1, 2, 3, 4] }),
    '/dtm/x',
  );

  assert.deepEqual(src.bbox, [1, 2, 3, 4]);
});

test('parseSourceJson: rejects malformed entries', () => {
  const at = '/dtm/x';

  assert.throws(() => parseSourceJson('not json', at), /Invalid source.json/);
  assert.throws(() => parseSourceJson('[]', at), /Invalid source.json/);
  assert.throws(
    () => parseSourceJson(JSON.stringify({ file: 'x.tif' }), at),
    /missing "name"/,
  );
  assert.throws(
    () =>
      parseSourceJson(
        JSON.stringify({ name: 'x', file: 'x.tif', bbox: [1, 2] }),
        at,
      ),
    /bad "bbox"/,
  );
  assert.throws(
    () =>
      parseSourceJson(
        JSON.stringify({
          name: 'x',
          file: 'x.tif',
          attributions: [{ url: 'u' }],
        }),
        at,
      ),
    /attribution needs a "name"/,
  );
});

test('loadElevationSources: empty root means no local sources', () => {
  assert.deepEqual(
    loadElevationSources('', () => {
      throw new Error('should not warn');
    }),
    [],
  );
});

test('loadElevationSources: reads directories in name order', () => {
  const root = mkdtempSync(join(tmpdir(), 'elev-'));

  for (const [dir, name] of [
    ['020-cz', 'cz'],
    ['010-sk', 'sk'],
    ['not-a-source', ''],
  ] as const) {
    mkdirSync(join(root, dir));

    if (name) {
      writeFileSync(
        join(root, dir, 'source.json'),
        JSON.stringify({ name, file: '/x.tif' }),
      );
    }
  }

  const warnings: string[] = [];

  const sources = loadElevationSources(root, (m) => warnings.push(m));

  // sorted by directory, so a numeric prefix sets priority; the directory
  // without a source.json is simply not a source, and says nothing about it
  assert.deepEqual(
    sources.map((s) => s.name),
    ['sk', 'cz'],
  );
  assert.deepEqual(warnings, []);
});

test('loadElevationSources: a bad source.json is skipped, not thrown', () => {
  // This runs during module evaluation, so a throw would take the whole API
  // down over one malformed file dropped into the directory.
  const root = mkdtempSync(join(tmpdir(), 'elev-'));

  mkdirSync(join(root, '010-good'));
  writeFileSync(
    join(root, '010-good', 'source.json'),
    JSON.stringify({ name: 'sk', file: '/x.tif' }),
  );

  mkdirSync(join(root, '020-broken'));
  writeFileSync(join(root, '020-broken', 'source.json'), '{ not json');

  const warnings: string[] = [];

  const sources = loadElevationSources(root, (m) => warnings.push(m));

  assert.deepEqual(
    sources.map((s) => s.name),
    ['sk'],
  );
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /020-broken/);
});

test('loadElevationSources: an unreadable root warns instead of throwing', () => {
  const warnings: string[] = [];

  const sources = loadElevationSources(
    join(tmpdir(), `definitely-not-here-${Date.now()}`),
    (m) => warnings.push(m),
  );

  assert.deepEqual(sources, []);
  assert.equal(warnings.length, 1);
});

test('mergeCredits: several rasters under one name keep every credit', () => {
  // Belgium is two licensed datasets reported under one name; overwriting would
  // leave one of them uncredited.
  const into = new Map<string, { name: string; url?: string }[]>();

  mergeCredits(into, 'be', [{ name: 'SPW', url: 'http://spw/' }]);
  mergeCredits(into, 'be', [{ name: 'DHMV II' }]);

  assert.deepEqual(into.get('be'), [
    { name: 'SPW', url: 'http://spw/' },
    { name: 'DHMV II' },
  ]);
});

test('mergeCredits: the same credit twice is credited once', () => {
  // A route crossing nine Sonny countries should not name Sonny nine times.
  const into = new Map<string, { name: string; url?: string }[]>();

  const sonny = [{ name: "Sonny's LiDAR DTM", url: 'https://sonny.4lima.de/' }];

  mergeCredits(into, 'sonny', sonny);
  mergeCredits(into, 'sonny', [...sonny]);

  assert.deepEqual(into.get('sonny'), sonny);
});

test('datasetBbox: identity for a geographic raster', () => {
  // A 1x1 degree SRTM-style tile at N48E017, no projection involved.
  const bbox = datasetBbox(
    [17, 1 / 3600, 0, 49, 0, -1 / 3600],
    3600,
    3600,
    null,
  );

  assert.ok(Math.abs(bbox[0] - 16.99) < 1e-6, `minLon ${bbox[0]}`);
  assert.ok(Math.abs(bbox[1] - 47.99) < 1e-6, `minLat ${bbox[1]}`);
  assert.ok(Math.abs(bbox[2] - 18.01) < 1e-6, `maxLon ${bbox[2]}`);
  assert.ok(Math.abs(bbox[3] - 49.01) < 1e-6, `maxLat ${bbox[3]}`);
});

test('datasetBbox: captures the bulge the corners miss', () => {
  // EPSG:3035 (ETRS89-LAEA) over a wide European sheet. The projection curves,
  // so the north edge reaches higher latitudes between the corners than at
  // them; a corner-only extent would clip that off and leave the source
  // unconsulted for points it holds.
  const srs = gdal.SpatialReference.fromEPSG(3035);

  const unproject = createInverseProjector(srs);

  assert.ok(unproject);

  // 3000 km wide, 1000 km tall, north of the projection's origin latitude
  const gt = [2500000, 1000, 0, 4200000, 0, -1000];

  const bbox = datasetBbox(gt, 3000, 1000, unproject);

  const cornerLats = [
    unproject(2500000, 4200000).lat,
    unproject(5500000, 4200000).lat,
    unproject(2500000, 3200000).lat,
    unproject(5500000, 3200000).lat,
  ];

  assert.ok(
    bbox[3] > Math.max(...cornerLats) + 0.5,
    `maxLat ${bbox[3]} should clear the corner max ${Math.max(...cornerLats)} ` +
      'by more than the margin — the curvature was not sampled',
  );
});

test('createInverseProjector: round-trips through the dataset CRS', () => {
  const srs = gdal.SpatialReference.fromEPSG(32632);

  const project = createProjector(srs);

  const unproject = createInverseProjector(srs);

  assert.ok(project);
  assert.ok(unproject);

  const { x, y } = project(13.405, 52.52);

  const back = unproject(x, y);

  assert.ok(Math.abs(back.lon - 13.405) < 1e-6, `lon ${back.lon}`);
  assert.ok(Math.abs(back.lat - 52.52) < 1e-6, `lat ${back.lat}`);
});

test('createInverseProjector: round-trips a lat-first CRS too', () => {
  // The mirror of the GEDTM30 bug: geographic EPSG:4326 wants its input pair
  // lat-first, so the swap has to move to the arguments on the way back.
  const srs = gdal.SpatialReference.fromEPSG(4326);

  const project = createProjector(srs);

  const unproject = createInverseProjector(srs);

  assert.ok(project);
  assert.ok(unproject);

  const { x, y } = project(19.8517, 45.1616);

  const back = unproject(x, y);

  assert.ok(Math.abs(back.lon - 19.8517) < 1e-9, `lon ${back.lon}`);
  assert.ok(Math.abs(back.lat - 45.1616) < 1e-9, `lat ${back.lat}`);
});
