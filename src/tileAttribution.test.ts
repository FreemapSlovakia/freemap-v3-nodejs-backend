import assert from 'node:assert/strict';
import test from 'node:test';
import {
  composeCredits,
  type LicenseDict,
  readTileCodes,
  TileCodeCollector,
} from './tileAttribution.js';

const LICENSES: LicenseDict = {
  osm: [{ title: '© OpenStreetMap contributors' }],
  'shading:_': [{ title: 'GEDTM30' }],
  'contours:_': [{ title: 'GEDTM30' }],
  'shading:sk': [{ title: 'DMR 5.0: ÚGKK SR' }],
  'contours:sk': [{ title: 'DMR 5.0: ÚGKK SR' }],
  'shading:at': [{ title: 'ALS DTM: Geoland.at' }],
  'shading:cz': [{ title: 'DMR 5G: ČÚZK' }],
};

function segment(marker: number, payload: Buffer) {
  const length = Buffer.alloc(2);

  length.writeUInt16BE(payload.length + 2);

  return Buffer.concat([Buffer.from([0xff, marker]), length, payload]);
}

const APP0 = segment(0xe0, Buffer.from('JFIF\0\x01\x02\0\0\x01\0\x01\0\0'));

const SOS = Buffer.from([0xff, 0xda, 0, 2]);

function jpeg(...segments: Buffer[]) {
  return Buffer.concat([Buffer.from([0xff, 0xd8]), ...segments, SOS]);
}

const com = (payload: string) => segment(0xfe, Buffer.from(payload));

test('readTileCodes: finds the COM segment after APP0 and right after SOI', () => {
  assert.deepEqual(readTileCodes(jpeg(APP0, com('c_,o,s_,ssk'))), [
    'c_',
    'o',
    's_',
    'ssk',
  ]);

  assert.deepEqual(readTileCodes(jpeg(com('o,ssk'), APP0)), ['o', 'ssk']);
});

test('readTileCodes: skips fill bytes, standalone markers and long headers', () => {
  const icc = segment(0xe2, Buffer.alloc(3000));

  assert.deepEqual(
    readTileCodes(
      jpeg(APP0, Buffer.from([0xff, 0xff, 0xff, 0xd0]), icc, com('o')),
    ),
    ['o'],
  );
});

test('readTileCodes: stops at the image data and at a truncated segment', () => {
  assert.equal(readTileCodes(Buffer.concat([jpeg(APP0), com('o')])), null);

  assert.equal(readTileCodes(jpeg(APP0, com('o,ssk')).subarray(0, 25)), null);
});

test('readTileCodes: an empty payload is known, no segment is not', () => {
  assert.deepEqual(readTileCodes(jpeg(APP0, com(''))), []);

  assert.equal(readTileCodes(jpeg(APP0)), null);

  assert.equal(readTileCodes(Buffer.from('\x89PNG')), null);

  assert.equal(readTileCodes(Buffer.alloc(0)), null);
});

test('composeCredits: Freemap, OSM, datasets alphabetically, fallback last', () => {
  assert.deepEqual(
    composeCredits(
      ['shading:_', 'shading:sk', 'contours:sk', 'shading:cz', 'shading:at'],
      LICENSES,
    ),
    [
      '©\xa0Freemap Slovakia',
      '© OpenStreetMap contributors',
      'ALS DTM: Geoland.at',
      'DMR 5.0: ÚGKK SR',
      'DMR 5G: ČÚZK',
      'GEDTM30',
    ],
  );
});

test('composeCredits: OSM is credited even when no tile named it', () => {
  assert.deepEqual(composeCredits([], LICENSES), [
    '©\xa0Freemap Slovakia',
    '© OpenStreetMap contributors',
  ]);
});

test('composeCredits: an unknown key refuses rather than drops a source', () => {
  assert.equal(composeCredits(['shading:xx'], LICENSES), null);
});

test('TileCodeCollector: narrows to the union of complete tiles', () => {
  const collector = new TileCodeCollector();

  collector.add(jpeg(APP0, com('o,ssk')));
  collector.add(jpeg(APP0, com('')));

  assert.deepEqual(collector.credits(LICENSES), [
    '©\xa0Freemap Slovakia',
    '© OpenStreetMap contributors',
    'DMR 5.0: ÚGKK SR',
  ]);
});

test('TileCodeCollector: one tile without codes widens to every dataset', () => {
  const collector = new TileCodeCollector();

  collector.add(jpeg(APP0, com('o,ssk')));
  collector.add(jpeg(APP0));

  assert.equal(collector.credits(LICENSES).length, 6);
});

test('TileCodeCollector: an unresolvable code widens to every dataset', () => {
  const collector = new TileCodeCollector();

  collector.add(jpeg(APP0, com('o,sxx')));

  assert.equal(collector.credits(LICENSES).length, 6);
});
