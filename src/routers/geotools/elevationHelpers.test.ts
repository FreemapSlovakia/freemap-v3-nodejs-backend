import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import gdal from 'gdal-async';
import {
  type Bbox,
  createInverseProjector,
  createProjector,
  datasetBbox,
  inBbox,
  loadElevationSources,
  mergeCredits,
  nameFromDir,
  parseSourceJson,
  srtmKey,
} from './elevationHelpers.js';

/**
 * The SRS of a 1x1 raster in `epsg`, written to disk and reopened the way production
 * opens its sources: as a GeoTIFF, or through a VRT over one, with the GDAL
 * settings the helpers module applies on import. Testing against a bare
 * `fromEPSG()` is what hid the gdal-async 3.13 double swap.
 */
function raster(
  t: TestContext,
  epsg: number,
  format: 'GTiff' | 'VRT' = 'GTiff',
) {
  const dir = mkdtempSync(join(tmpdir(), 'elevation-srs-'));

  let dataset: gdal.Dataset | undefined;

  // registered before any GDAL call, so a failing one still cleans up
  t.after(() => {
    dataset?.close();

    rmSync(dir, { recursive: true, force: true });
  });

  const tif = join(dir, 'raster.tif');

  const created = gdal.open(tif, 'w', 'GTiff', 1, 1, 1, gdal.GDT_Float32);

  created.srs = gdal.SpatialReference.fromEPSG(epsg);

  created.geoTransform = [0, 1, 0, 0, 0, -1];

  created.close();

  let path = tif;

  if (format === 'VRT') {
    path = join(dir, 'raster.vrt');

    gdal.buildVRT(path, [tif]).close();
  }

  dataset = gdal.open(path);

  // the SRS as production reads it from an opened source
  return dataset.srs;
}

test('createProjector: applies the datum shift a proj4 string would drop', (t) => {
  // Charing Cross in OSGB36 / British National Grid. Going through
  // `toProj4()` loses the OSGB36 datum transformation and lands ~113 m west,
  // near 529916 — which is what silently misread every English sample.
  const project = createProjector(raster(t, 27700));

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

test('createProjector: easting first for a northing-first CRS', (t) => {
  // EPSG:3035 (ETRS89-LAEA) declares northing first; the projector must still
  // report (x, y) for a dataset in it.
  const project = createProjector(raster(t, 3035));

  assert.ok(project);

  const { x, y } = project(10, 50);

  assert.ok(Math.abs(x - 4321000) < 25, `easting ${x} looks like a northing`);
  assert.ok(Math.abs(y - 2987511) < 25, `northing ${y} looks like an easting`);
});

for (const format of ['GTiff', 'VRT'] as const) {
  test(`createProjector: Poland (EPSG:2180, northing first), ${format}`, (t) => {
    // The point that came back as 93.8 m instead of ~200 m: a double swap moved
    // the read ~144 km across the PL raster to (381812, 525816). The PL source
    // is a VRT, so that path is pinned too.
    const project = createProjector(raster(t, 2180, format));

    assert.ok(project);

    const { x, y } = project(19.37044143676758, 51.302393994424605);

    assert.ok(Math.abs(x - 525816.6) < 1, `easting ${x}`);
    assert.ok(Math.abs(y - 381812.5) < 1, `northing ${y}`);
  });

  test(`createProjector: lon first for geographic EPSG:4326, ${format}`, (t) => {
    // GEDTM30 carries a plain EPSG:4326 SRS, whose authority axis order is
    // lat/lon. A lat/lon pair fed to the geotransform reads the wrong
    // continent (Fruska Gora came back as 702 m, an Arabian plateau).
    const project = createProjector(raster(t, 4326, format));

    assert.ok(project);

    const { x, y } = project(19.851715564727787, 45.16161498912903);

    assert.ok(Math.abs(x - 19.851715564727787) < 1e-9, `x ${x} is a latitude`);
    assert.ok(Math.abs(y - 45.16161498912903) < 1e-9, `y ${y} is a longitude`);
  });
}

for (const [label, rebuild] of [
  // what gdal-async up to 3.12 handed out as `dataset.srs`
  [
    'rebuilt from WKT',
    (srs: gdal.SpatialReference) => gdal.SpatialReference.fromWKT(srs.toWKT()),
  ],
  ['bare fromEPSG', () => gdal.SpatialReference.fromEPSG(2180)],
] as const) {
  // Without OSR_DEFAULT_AXIS_MAPPING_STRATEGY these come back in the
  // authority's order, northing first — the 3.12 behaviour. Under 3.13 a
  // dataset's own SRS is easting-first regardless, so only these pin the
  // option itself.
  test(`createProjector: easting first for an SRS ${label}`, (t) => {
    const srs = rebuild(raster(t, 2180) as gdal.SpatialReference);

    const project = createProjector(srs);

    const unproject = createInverseProjector(srs);

    assert.ok(project);
    assert.ok(unproject);

    const { x, y } = project(19.37044143676758, 51.302393994424605);

    assert.ok(Math.abs(x - 525816.6) < 1, `easting ${x}`);
    assert.ok(Math.abs(y - 381812.5) < 1, `northing ${y}`);

    const { lon, lat } = unproject(525816.6, 381812.5);

    assert.ok(Math.abs(lon - 19.370441) < 1e-5, `lon ${lon}`);
    assert.ok(Math.abs(lat - 51.302394) < 1e-5, `lat ${lat}`);
  });
}

test('createProjector: null without an SRS', () => {
  assert.equal(createProjector(null), null);
  assert.equal(createInverseProjector(null), null);
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

/**
 * A dataset directory under a fresh temporary root, linking its raster as
 * `source.vrt`; the root goes when the test ends.
 */
function datasets(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'elev-'));

  t.after(() => rmSync(root, { recursive: true, force: true }));

  return {
    root,
    add(dir: string, json: unknown = {}) {
      const path = join(root, dir);

      mkdirSync(path);
      symlinkSync(join(root, `${dir}.vrt`), join(path, 'source.vrt'));
      writeFileSync(join(path, 'source.json'), JSON.stringify(json));

      return path;
    },
  };
}

test('parseSourceJson: name, raster and attributions', (t) => {
  const dir = datasets(t).add('245-de_by', {
    attributions: [{ name: 'DGM1', url: 'https://geodaten.bayern.de/' }],
  });

  const src = parseSourceJson(
    readFileSync(join(dir, 'source.json'), 'utf8'),
    dir,
  );

  assert.equal(src.name, 'de');
  assert.equal(src.path, join(dir, 'source.vrt'));
  assert.equal(src.bbox, undefined);
  assert.deepEqual(src.attributions, [
    { name: 'DGM1', url: 'https://geodaten.bayern.de/' },
  ]);
});

test('parseSourceJson: several credits under one name', (t) => {
  // A dataset merged from two providers must show both credits.
  const dir = datasets(t).add('232-be_wal');

  const src = parseSourceJson(
    JSON.stringify({
      attributions: [{ name: 'SPW', url: 'http://spw/' }, { name: 'DHMV II' }],
    }),
    dir,
  );

  assert.deepEqual(src.attributions, [
    { name: 'SPW', url: 'http://spw/' },
    { name: 'DHMV II' },
  ]);
});

test('nameFromDir: the datasets of one model share a name', () => {
  // the part past the number, up to the first - or _
  for (const [dir, name] of [
    ['/dtm/245-de_by', 'de'],
    ['/dtm/090-es-29', 'es'],
    ['/dtm/232-be_wal', 'be'],
    ['/dtm/010-sk', 'sk'],
    ['/dtm/999-gedtm30', 'gedtm30'],
  ]) {
    assert.equal(nameFromDir(dir), name);
  }
});

test('parseSourceJson: a "name" in source.json is not read', (t) => {
  const dir = datasets(t).add('340-gb');

  assert.equal(
    parseSourceJson(JSON.stringify({ name: 'sonny' }), dir).name,
    'gb',
  );
});

test('nameFromDir: a directory without NNN-lowercase gives no name', () => {
  for (const dir of [
    '/dtm/010_sk',
    '/dtm/245-DE_by',
    '/dtm/300.5-at',
    '/dtm/sk',
  ]) {
    assert.throws(() => nameFromDir(dir), /No name/, dir);
  }
});

test('parseSourceJson: the raster is the source link, dangling or not', (t) => {
  const { root, add } = datasets(t);

  // a link whose target is not mounted yet still names the source
  const dir = add('245-de_by');

  assert.equal(parseSourceJson('{}', dir).path, join(dir, 'source.vrt'));

  // a directory under the name is not a raster
  const other = join(root, '246-de_nw');

  mkdirSync(join(other, 'source.vrt'), { recursive: true });

  assert.throws(() => parseSourceJson('{}', other), /No raster/);
});

test('parseSourceJson: a pinned bbox is kept', (t) => {
  const dir = datasets(t).add('010-sk');

  assert.deepEqual(
    parseSourceJson(JSON.stringify({ bbox: [1, 2, 3, 4] }), dir).bbox,
    [1, 2, 3, 4],
  );
});

test('parseSourceJson: rejects malformed entries', (t) => {
  const at = datasets(t).add('010-sk');

  assert.throws(() => parseSourceJson('not json', at), /Invalid source.json/);
  assert.throws(() => parseSourceJson('[]', at), /Invalid source.json/);
  assert.throws(
    () => parseSourceJson(JSON.stringify({ bbox: [1, 2] }), at),
    /bad "bbox"/,
  );
  assert.throws(
    () => parseSourceJson(JSON.stringify({ attributions: [{ url: 'u' }] }), at),
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

test('loadElevationSources: reads directories in name order', (t) => {
  const { root, add } = datasets(t);

  add('255-cz');
  add('010-sk');
  mkdirSync(join(root, 'not-a-source'));

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

test('loadElevationSources: a bad source.json is skipped, not thrown', (t) => {
  // This runs during module evaluation, so a throw would take the whole API
  // down over one malformed file dropped into the directory.
  const { root, add } = datasets(t);

  add('010-sk');
  add('020-broken');
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

test('datasetBbox: captures the bulge the corners miss', (t) => {
  // EPSG:3035 (ETRS89-LAEA) over a wide European sheet. The projection curves,
  // so the north edge reaches higher latitudes between the corners than at
  // them; a corner-only extent would clip that off and leave the source
  // unconsulted for points it holds.
  const unproject = createInverseProjector(raster(t, 3035));

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

test('createInverseProjector: round-trips through the dataset CRS', (t) => {
  const srs = raster(t, 32632);

  const project = createProjector(srs);

  const unproject = createInverseProjector(srs);

  assert.ok(project);
  assert.ok(unproject);

  const { x, y } = project(13.405, 52.52);

  const back = unproject(x, y);

  assert.ok(Math.abs(back.lon - 13.405) < 1e-6, `lon ${back.lon}`);
  assert.ok(Math.abs(back.lat - 52.52) < 1e-6, `lat ${back.lat}`);
});

for (const format of ['GTiff', 'VRT'] as const) {
  // Fixed expectations rather than a round trip: a round trip passes even when
  // both directions are swapped, and the inverse alone decides the footprint
  // a source is consulted for, cached for the life of the process.
  test(`createInverseProjector: Poland (EPSG:2180) easting first, ${format}`, (t) => {
    const unproject = createInverseProjector(raster(t, 2180, format));

    assert.ok(unproject);

    const { lon, lat } = unproject(525816.6, 381812.5);

    assert.ok(Math.abs(lon - 19.370441) < 1e-5, `lon ${lon}`);
    assert.ok(Math.abs(lat - 51.302394) < 1e-5, `lat ${lat}`);
  });

  test(`createInverseProjector: EPSG:4326 lon first, ${format}`, (t) => {
    const unproject = createInverseProjector(raster(t, 4326, format));

    assert.ok(unproject);

    const { lon, lat } = unproject(19.8517, 45.1616);

    assert.ok(Math.abs(lon - 19.8517) < 1e-9, `lon ${lon}`);
    assert.ok(Math.abs(lat - 45.1616) < 1e-9, `lat ${lat}`);
  });
}
