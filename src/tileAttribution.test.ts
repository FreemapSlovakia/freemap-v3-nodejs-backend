import assert from 'node:assert/strict';
import test from 'node:test';
import {
  composeCredits,
  type LicenseDict,
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

  collector.add('o,ssk');
  collector.add('');

  assert.deepEqual(collector.credits(LICENSES), [
    '©\xa0Freemap Slovakia',
    '© OpenStreetMap contributors',
    'DMR 5.0: ÚGKK SR',
  ]);
});

test('TileCodeCollector: one tile without the header widens to every dataset', () => {
  const collector = new TileCodeCollector();

  collector.add('o,ssk');
  collector.add(undefined);

  assert.equal(collector.credits(LICENSES).length, 6);
});

test('TileCodeCollector: an unresolvable code widens to every dataset', () => {
  const collector = new TileCodeCollector();

  collector.add('o,sxx');

  assert.equal(collector.credits(LICENSES).length, 6);
});
