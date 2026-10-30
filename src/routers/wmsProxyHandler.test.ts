import assert from 'node:assert/strict';
import test from 'node:test';
import type { CatalogMap } from '../mapCatalog.js';
import {
  ALLOWED_TYPES,
  Backoff,
  isCapabilities,
  isPublicAddress,
  redirectAllowed,
  rootElement,
  upstreamUrl,
  wmsRequest,
} from './wmsProxyHandler.js';

test('isPublicAddress: public addresses pass, private and special ones fail', () => {
  for (const address of ['8.8.8.8', '193.87.1.1', '2a00:1450:4001::1']) {
    assert.equal(isPublicAddress(address), true, address);
  }

  for (const address of [
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '::1',
    '::',
    '::ffff:127.0.0.1',
    '::a00:1',
    '2002:a00:1::',
    '2001:0:a00:1::',
    '::ffff:0:7f00:1',
    'fec0::1',
    '64:ff9b:1::a00:1',
    'fd00::1',
    'fe80::1',
    'not-an-ip',
  ]) {
    assert.equal(isPublicAddress(address), false, address);
  }
});

const params = (query: string) => new URLSearchParams(query);

test('wmsRequest: one SERVICE=WMS and one allowed REQUEST', () => {
  assert.equal(
    wmsRequest(params('service=WMS&request=GetCapabilities')),
    'getcapabilities',
  );

  assert.equal(
    wmsRequest(params('SERVICE=wms&REQUEST=getfeatureinfo&i=1')),
    'getfeatureinfo',
  );

  for (const query of [
    'service=WMS&request=GetMap',
    'service=WMS&request=GetLegendGraphic',
    'service=WMS&request=GetCapabilities&REQUEST=GetMap',
    'service=WMS&service=WMS&request=GetCapabilities',
    'service=WFS&request=GetCapabilities',
    'request=GetCapabilities',
  ]) {
    assert.equal(wmsRequest(params(query)), undefined, query);
  }
});

const map: CatalogMap = {
  type: 'ABCDE',
  technology: 'wms',
  body: { url: 'https://example.com/wms?map=/x.map', layers: ['a'] },
};

test('upstreamUrl: the catalog URL keeps its own parameters', () => {
  const url = upstreamUrl(
    map,
    params('map=/etc/passwd&service=WMS&request=GetFeatureInfo&i=3'),
    'getfeatureinfo',
  );

  assert.equal(url.origin + url.pathname, 'https://example.com/wms');

  assert.deepEqual(url.searchParams.getAll('map'), ['/x.map']);

  assert.equal(url.searchParams.get('i'), '3');
});

test('upstreamUrl: one capabilities URL whatever the client sends', () => {
  const capabilities = (query: string) =>
    upstreamUrl(map, params(query), 'getcapabilities').toString();

  const expected =
    'https://example.com/wms?map=%2Fx.map&SERVICE=WMS&REQUEST=GetCapabilities&VERSION=1.3.0';

  for (const query of [
    'service=WMS&request=GetCapabilities&version=1.3.0&junk=1',
    'SERVICE=wms&REQUEST=getcapabilities&version=x1',
    'service=WMS&request=GetCapabilities',
  ]) {
    assert.equal(capabilities(query), expected, query);
  }

  assert.match(
    capabilities('service=WMS&request=GetCapabilities&version=1.1.1'),
    /VERSION=1\.1\.1$/,
  );
});

test('upstreamUrl: feature info passes standard parameters only', () => {
  const url = upstreamUrl(
    { ...map, body: { url: 'https://example.com/wms', layers: ['a'] } },
    params(
      'service=WMS&request=GetFeatureInfo&I=3&query_layers=a&map=/etc/passwd&SLD=http://x/y.sld&env=a:b&TIME=2024&DIM_BAND=1',
    ),
    'getfeatureinfo',
  );

  assert.deepEqual(
    [...url.searchParams.keys()],
    ['service', 'request', 'I', 'query_layers', 'TIME', 'DIM_BAND'],
  );
});

test('Backoff: a key is held for its time, then released', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });

  const backoff = new Backoff(1000);

  backoff.add('a');

  assert.equal(backoff.has('a'), true);

  assert.equal(backoff.has('b'), false);

  t.mock.timers.tick(1000);

  assert.equal(backoff.has('a'), false);
});

test('ALLOWED_TYPES: XML, GML, JSON, HTML and text, nothing that merely contains them', () => {
  for (const type of [
    'text/xml',
    'text/xml; charset=utf-8',
    'text/html;charset=UTF-8',
    'application/vnd.ogc.gml',
    'application/vnd.ogc.gml/3.1.1',
    'application/vnd.ogc.se_xml',
    'application/geo+json',
  ]) {
    assert.equal(ALLOWED_TYPES.test(type), true, type);
  }

  for (const type of ['application/x-xml-whatever', 'image/png', '']) {
    assert.equal(ALLOWED_TYPES.test(type), false, type);
  }
});

test('upstreamUrl: one of each feature-info parameter, whatever its case', () => {
  const url = upstreamUrl(
    { ...map, body: { url: 'https://example.com/wms', layers: ['a'] } },
    params(
      'service=WMS&request=GetFeatureInfo&QUERY_LAYERS=a&query_layers=secret',
    ),
    'getfeatureinfo',
  );

  assert.deepEqual(
    [...url.searchParams].filter(([k]) => k.toLowerCase() === 'query_layers'),
    [['QUERY_LAYERS', 'a']],
  );
});

test('redirectAllowed: same origin, path and request', () => {
  const from = new URL(
    'https://example.com/wms?service=WMS&request=GetCapabilities',
  );

  const ok = (to: string) =>
    redirectAllowed(from, new URL(to), 'getcapabilities');

  assert.equal(
    ok('https://example.com/wms/?service=WMS&request=GetCapabilities'),
    true,
  );

  assert.equal(
    ok('https://example.com:443/wms?service=WMS&request=GetCapabilities'),
    true,
  );

  for (const to of [
    'http://example.com/wms?service=WMS&request=GetCapabilities',
    'https://other.com/wms?service=WMS&request=GetCapabilities',
    'https://example.com:8443/wms?service=WMS&request=GetCapabilities',
    'https://example.com/private?service=WMS&request=GetCapabilities',
    'https://example.com/wms?service=WMS&request=GetMap',
  ]) {
    assert.equal(ok(to), false, to);
  }
});

test('isCapabilities: a capabilities root, in UTF-8 or UTF-16', () => {
  const answer = (body: Buffer, status = 200) => ({
    status,
    type: 'text/xml',
    body,
  });

  const xml = '<?xml version="1.0"?><WMS_Capabilities version="1.3.0"/>';

  assert.equal(isCapabilities(answer(Buffer.from(xml))), true);

  assert.equal(
    isCapabilities(
      answer(
        Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, 'utf16le')]),
      ),
    ),
    true,
  );

  assert.equal(
    isCapabilities(answer(Buffer.from('<ServiceExceptionReport/>'))),
    false,
  );

  assert.equal(isCapabilities(answer(Buffer.from(xml), 500)), false);

  // A prolog, a comment and a doctype may come first; a page that only quotes
  // the root element is no document.
  assert.equal(
    isCapabilities(
      answer(
        Buffer.from(
          '<?xml version="1.0"?>\n<!-- x -->\n<!DOCTYPE WMT_MS_Capabilities SYSTEM "x.dtd" [ <!ELEMENT a ANY> ]>\n<WMT_MS_Capabilities version="1.1.1"/>',
        ),
      ),
    ),
    true,
  );

  assert.equal(
    isCapabilities(
      answer(Buffer.from('<html><pre>&lt;WMS_Capabilities <WMS_Capabilities')),
    ),
    false,
  );

  // UTF-16BE cut to an odd length.
  assert.equal(
    isCapabilities(answer(Buffer.from([0xfe, 0xff, 0x00, 0x3c, 0x00]))),
    false,
  );

  // A UTF-8 byte-order mark first.
  assert.equal(
    isCapabilities(
      answer(
        Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(xml)]),
      ),
    ),
    true,
  );
});

test('rootElement: past the prolog, linear on many comments, ends on malformed input', () => {
  assert.equal(rootElement('<?xml?><!--a--><!--b--><x:Root a="1">'), 'x:Root');

  assert.equal(rootElement('<!DOCTYPE r [ <!ENTITY e ">"> ]><Root/>'), 'Root');

  // A regex over this backtracked exponentially.
  const started = Date.now();

  assert.equal(
    rootElement(`${'<!-- x -->'.repeat(5000)}<ServiceExceptionReport>`),
    'ServiceExceptionReport',
  );

  assert.ok(Date.now() - started < 1000);

  for (const text of ['<!-- open', '<?xml', '<!DOCTYPE r [ <!ENTITY', '']) {
    assert.equal(rootElement(text), undefined, text);
  }
});
