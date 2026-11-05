import assert from 'node:assert/strict';
import test from 'node:test';
import { NO_EMAIL, nextEmail, normalizeEmail } from './emailAddress.js';

const verified = {
  email: 'Jan.Novak@gmail.com',
  emailKey: 'jannovak@gmail.com',
  emailVerified: true,
};

test('a proof survives a change within the same mailbox only', () => {
  assert.deepEqual(nextEmail(verified, 'jannovak+x@gmail.com'), {
    email: 'jannovak+x@gmail.com',
    emailKey: 'jannovak@gmail.com',
    emailVerified: true,
  });

  assert.equal(nextEmail(verified, 'other@gmail.com').emailVerified, false);
});

test('a proven address is verified, a cleared one is gone', () => {
  assert.equal(
    nextEmail(NO_EMAIL, 'a@b.sk', { proven: true }).emailVerified,
    true,
  );

  assert.deepEqual(nextEmail(verified, null), NO_EMAIL);
});

test('keepExisting fills an empty account and only adds a proof otherwise', () => {
  assert.deepEqual(nextEmail(NO_EMAIL, 'a@b.sk', { keepExisting: true }), {
    email: 'a@b.sk',
    emailKey: 'a@b.sk',
    emailVerified: false,
  });

  const unverified = { ...verified, emailVerified: false };

  assert.deepEqual(
    nextEmail(unverified, 'other@b.sk', { proven: true, keepExisting: true }),
    unverified,
  );

  assert.equal(
    nextEmail(unverified, 'jan.novak@gmail.com', {
      proven: true,
      keepExisting: true,
    }).emailVerified,
    true,
  );

  assert.deepEqual(nextEmail(verified, null, { keepExisting: true }), verified);
});

test('folds Gmail dots, sub-address and googlemail.com', () => {
  assert.equal(
    normalizeEmail('M.Zdila+maps@GoogleMail.com'),
    'mzdila@gmail.com',
  );
});

test('drops only the sub-address where dots matter', () => {
  assert.equal(
    normalizeEmail('jan.novak+x@outlook.com'),
    'jan.novak@outlook.com',
  );
});

test("keeps a Yahoo disposable address apart from its base's owner", () => {
  assert.equal(normalizeEmail('alice-k@yahoo.com'), 'alice-k@yahoo.com');
});

test('only lowercases an unknown domain', () => {
  assert.equal(
    normalizeEmail(' Jan.Novak+x@Example.SK '),
    'jan.novak+x@example.sk',
  );
});

test('only lowercases a stored value without @', () => {
  assert.equal(normalizeEmail(' Jan.Novak '), 'jan.novak');
});

test('keeps a local part that starts with the separator', () => {
  assert.equal(normalizeEmail('+x@gmail.com'), '+x@gmail.com');
});
