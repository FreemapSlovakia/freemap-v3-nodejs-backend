import assert from 'node:assert/strict';
import test from 'node:test';
import {
  filterToken,
  parseFilterToken,
  parseWatchToken,
  watchToken,
} from './mailWatch.js';

test('a watch token reads back as what it was signed for', () => {
  process.env['MAIL_TOKEN_SECRET'] = 'test-secret';

  const token = watchToken(42, 'event', 'EnBUUqNH');

  assert.ok(token);

  assert.deepEqual(parseWatchToken(token), {
    userId: 42,
    target: 'event',
    targetId: 'EnBUUqNH',
  });
});

test('a changed or foreign token is refused', () => {
  process.env['MAIL_TOKEN_SECRET'] = 'test-secret';

  const token = watchToken(42, 'picture', 7)!;

  assert.equal(parseWatchToken(token.replace('42.', '43.')), null);

  assert.equal(parseWatchToken(token.replace('picture', 'event')), null);

  assert.equal(parseWatchToken('x'), null);

  process.env['MAIL_TOKEN_SECRET'] = 'other-secret';

  assert.equal(parseWatchToken(token), null);
});

test('a saved filter token reads back, and never as a watch token', () => {
  process.env['MAIL_TOKEN_SECRET'] = 'test-secret';

  const token = filterToken(42, 28)!;

  assert.deepEqual(parseFilterToken(token), { userId: 42, filterId: 28 });

  assert.equal(parseWatchToken(token), null);

  assert.equal(parseFilterToken(token.replace('42.', '43.')), null);

  assert.equal(parseFilterToken(watchToken(42, 'event', '28')!), null);
});

test('without a secret there are no tokens', () => {
  delete process.env['MAIL_TOKEN_SECRET'];

  assert.equal(watchToken(1, 'event', 'a'), null);
});
