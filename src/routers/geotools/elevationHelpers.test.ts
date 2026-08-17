import assert from 'node:assert/strict';
import test from 'node:test';
import gdal from 'gdal-async';
import {
  type Bbox,
  createProjector,
  inBbox,
  parseElevationSources,
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

test('parseElevationSources: empty config yields no sources', () => {
  assert.deepEqual(parseElevationSources(''), []);
  assert.deepEqual(parseElevationSources('  ;  '), []);
});

test('parseElevationSources: single and multiple entries in order', () => {
  assert.deepEqual(parseElevationSources('a:/data/a.tif:16.8,47.7,22.6,49.7'), [
    { name: 'a', path: '/data/a.tif', bbox: [16.8, 47.7, 22.6, 49.7] },
  ]);

  assert.deepEqual(
    parseElevationSources(
      'a:/data/a.tif:16.8,47.7,22.6,49.7;b:/data/b.tif:0,0,1,1',
    ),
    [
      { name: 'a', path: '/data/a.tif', bbox: [16.8, 47.7, 22.6, 49.7] },
      { name: 'b', path: '/data/b.tif', bbox: [0, 0, 1, 1] },
    ],
  );
});

test('parseElevationSources: newlines separate entries too', () => {
  const expected = [
    { name: 'a', path: '/data/a.tif', bbox: [1, 2, 3, 4] },
    { name: 'b', path: '/data/b.tif', bbox: [5, 6, 7, 8] },
  ];

  // one source per line, no semicolons
  assert.deepEqual(
    parseElevationSources('a:/data/a.tif:1,2,3,4\nb:/data/b.tif:5,6,7,8\n'),
    expected,
  );

  // semicolon-terminated lines, which is what the old parser accepted
  assert.deepEqual(
    parseElevationSources('a:/data/a.tif:1,2,3,4;\nb:/data/b.tif:5,6,7,8;\n'),
    expected,
  );
});

test('parseElevationSources: rejects entry missing the name or the bbox', () => {
  assert.throws(
    () => parseElevationSources('/data/a.tif'),
    /Invalid ELEVATION_SOURCES entry/,
  );

  // no name — the old two-field format is not accepted
  assert.throws(
    () => parseElevationSources('/data/a.tif:1,2,3,4'),
    /Invalid ELEVATION_SOURCES entry/,
  );

  assert.throws(
    () => parseElevationSources(':/data/a.tif:1,2,3,4'),
    /Invalid ELEVATION_SOURCES entry/,
  );

  assert.throws(
    () => parseElevationSources('a::1,2,3,4'),
    /Invalid ELEVATION_SOURCES entry/,
  );

  // paths must not contain colons
  assert.throws(
    () => parseElevationSources('a:C:/maps/a.tif:1,2,3,4'),
    /Invalid ELEVATION_SOURCES entry/,
  );
});

test('parseElevationSources: rejects malformed bbox', () => {
  assert.throws(
    () => parseElevationSources('a:/data/a.tif:1,2,3'),
    /Invalid bbox/,
  );

  assert.throws(
    () => parseElevationSources('a:/data/a.tif:1,2,3,x'),
    /Invalid bbox/,
  );
});
