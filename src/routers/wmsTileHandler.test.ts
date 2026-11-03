import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import type { CatalogMap } from '../mapCatalog.js';
import { layerNamesOf, unescapeXml } from './wmsProxyHandler.js';
import {
  canonicalLayers,
  composeBest,
  Gate,
  getMapUrl,
  tileBounds,
  tileInBbox,
} from './wmsTileHandler.js';

test('canonicalLayers: one spelling per set, as encodeURIComponent writes it', () => {
  const classes = ['#FFD9B3', '#FF8C1A'];

  assert.deepEqual(canonicalLayers('layers=a%2Cb&v=1.ffd9b3-ff8c1a', classes), [
    'a',
    'b',
  ]);

  assert.deepEqual(
    canonicalLayers('layers=%C5%A5a%C5%BEba&v=12.ffd9b3-ff8c1a', classes),
    ['ťažba'],
  );

  assert.deepEqual(canonicalLayers('layers=a&v=1.', undefined), ['a']);

  for (const q of [
    'layers=a,b&v=1.ffd9b3-ff8c1a',
    'layers=%61&v=1.ffd9b3-ff8c1a',
    'layers=a%2Ca&v=1.ffd9b3-ff8c1a',
    'layers=a%2C&v=1.ffd9b3-ff8c1a',
    'layers=&v=1.ffd9b3-ff8c1a',
    'layers=a',
    'layers=a&v=1.ffd9b3',
    'layers=a&v=0.ffd9b3-ff8c1a',
    'layers=a&v=1.ffd9b3-ff8c1a&x=1',
    'v=1.ffd9b3-ff8c1a&layers=a',
    'layers=%E0&v=1.ffd9b3-ff8c1a',
  ]) {
    assert.equal(canonicalLayers(q, classes), undefined, q);
  }
});

test('unescapeXml: named and numeric entities, unknown ones kept', () => {
  assert.equal(
    unescapeXml('a&amp;b&lt;&#x165;&#353;&nbsp;&#x110000;'),
    'a&b<ťš&nbsp;&#x110000;',
  );
});

test('layerNamesOf: layer names only, in the declared encoding', () => {
  const doc = (encoding: string, name: string) =>
    `<?xml version="1.0" encoding="${encoding}"?><WMS_Capabilities><Service><Name>WMS</Name></Service><Capability><Layer><Title>t</Title><Layer queryable="1"><Name>${name}</Name><Style><Name>s</Name></Style></Layer></Layer></Capability></WMS_Capabilities>`;

  assert.deepEqual(
    [...layerNamesOf(Buffer.from(doc('UTF-8', 'a&amp;ť')))],
    ['a&ť'],
  );

  assert.deepEqual(
    [
      ...layerNamesOf(
        Buffer.from(
          new Uint8Array(
            [...doc('ISO-8859-2', 'ťa')].map((c) =>
              c === 'ť' ? 0xbb : c.charCodeAt(0),
            ),
          ),
        ),
      ),
    ],
    ['ťa'],
  );
});

test('composeBest: each pixel its best class as opacity in the best colour, none clear', async () => {
  const tile = (rgba: number[]) =>
    sharp(Buffer.from(Array.from({ length: 256 * 256 }, () => rgba).flat()), {
      raw: { width: 256, height: 256, channels: 4 },
    })
      .png()
      .toBuffer();

  const pixel = async (tiles: Buffer[]) => [
    ...(
      await sharp(await composeBest(tiles, ['#FFD9B3', '#FF8C1A']))
        .ensureAlpha()
        .raw()
        .toBuffer()
    ).subarray(0, 4),
  ];

  const basic = await tile([255, 218, 179, 191]);

  const robust = await tile([255, 140, 25, 191]);

  const none = await tile([255, 255, 255, 191]);

  assert.deepEqual(await pixel([robust, basic]), [255, 140, 26, 255]);

  assert.deepEqual(await pixel([basic, none]), [255, 140, 26, 128]);

  assert.deepEqual((await pixel([none]))[3], 0);
});

test('Gate: background waits behind everyone else', async () => {
  const gate = new Gate(1);

  const signal = new AbortController().signal;

  assert.equal(await gate.enter(signal), true);

  const order: string[] = [];

  const background = gate
    .enter(signal, 'background')
    .then(() => order.push('background'));

  const normal = gate.enter(signal).then(() => order.push('normal'));

  gate.leave();

  await normal;

  gate.leave();

  await background;

  assert.deepEqual(order, ['normal', 'background']);
});

test('tileBounds: zoom 0 is the world, zoom 1 its quarters', () => {
  const half = 20037508.342789244;

  assert.deepEqual(tileBounds(0, 0, 0), [-half, -half, half, half]);

  assert.deepEqual(tileBounds(1, 1, 0), [0, 0, half, half]);
});

test('tileInBbox: Slovakia, not the Atlantic; no bbox covers all', () => {
  const sk: CatalogMap['bbox'] = [16.83, 47.73, 22.57, 49.61];

  // Zoom 10 around Banská Bystrica.
  assert.equal(tileInBbox(sk, 10, 566, 352), true);

  assert.equal(tileInBbox(sk, 10, 400, 352), false);

  assert.equal(tileInBbox(undefined, 10, 400, 352), true);
});

test('getMapUrl: the map URL keeps its own parameters, ours replace any case', () => {
  const map: CatalogMap = {
    type: 'FSK99',
    layer: 'overlay',
    body: { url: 'https://example.org/ows?map=a&request=GetCapabilities' },
  };

  const url = getMapUrl(map, ['a', 'b'], 1, 1, 0);

  assert.equal(url.searchParams.get('map'), 'a');

  assert.equal(url.searchParams.get('request'), null);

  assert.equal(url.searchParams.get('REQUEST'), 'GetMap');

  assert.equal(url.searchParams.get('LAYERS'), 'a,b');

  assert.equal(url.searchParams.get('FORMAT'), 'image/png');
});

test('Gate: hands a slot to the next waiting, drops the aborted', async () => {
  const gate = new Gate(1);

  const ac = new AbortController();

  assert.equal(await gate.enter(ac.signal), true);

  const aborted = new AbortController();

  const dropped = gate.enter(aborted.signal);

  const next = gate.enter(ac.signal);

  aborted.abort();

  assert.equal(await dropped, false);

  gate.leave();

  assert.equal(await next, true);

  gate.leave();

  assert.equal(await gate.enter(ac.signal), true);
});
