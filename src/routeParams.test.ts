import assert from 'node:assert/strict';
import test from 'node:test';
import { parseId } from './routeParams.js';

test('an id is a decimal number an INT UNSIGNED column holds', () => {
  assert.equal(parseId('12'), 12);
  assert.equal(parseId('012'), 12);
  assert.equal(parseId('4294967295'), 4294967295);
});

test('anything else is no id', () => {
  for (const raw of [
    undefined,
    '',
    '12abc',
    '1e3',
    '0x10',
    ' 12',
    '-1',
    '1.5',
    '4294967296',
    '9'.repeat(400),
  ]) {
    assert.equal(parseId(raw), null, String(raw));
  }
});
