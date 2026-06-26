import assert from 'node:assert/strict';
import test from 'node:test';
import {
  type Bbox,
  inBbox,
  parseElevationSources,
  srtmKey,
} from './elevationHelpers.js';

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
  assert.deepEqual(parseElevationSources('/data/a.tif:16.8,47.7,22.6,49.7'), [
    { path: '/data/a.tif', bbox: [16.8, 47.7, 22.6, 49.7] },
  ]);

  assert.deepEqual(
    parseElevationSources(
      '/data/a.tif:16.8,47.7,22.6,49.7;/data/b.tif:0,0,1,1',
    ),
    [
      { path: '/data/a.tif', bbox: [16.8, 47.7, 22.6, 49.7] },
      { path: '/data/b.tif', bbox: [0, 0, 1, 1] },
    ],
  );
});

test('parseElevationSources: path may contain colons', () => {
  assert.deepEqual(parseElevationSources('C:/maps/a.tif:1,2,3,4'), [
    { path: 'C:/maps/a.tif', bbox: [1, 2, 3, 4] },
  ]);
});

test('parseElevationSources: rejects entry without bbox separator', () => {
  assert.throws(
    () => parseElevationSources('/data/a.tif'),
    /Invalid ELEVATION_SOURCES entry/,
  );
});

test('parseElevationSources: rejects malformed bbox', () => {
  assert.throws(
    () => parseElevationSources('/data/a.tif:1,2,3'),
    /Invalid bbox/,
  );

  assert.throws(
    () => parseElevationSources('/data/a.tif:1,2,3,x'),
    /Invalid bbox/,
  );
});
