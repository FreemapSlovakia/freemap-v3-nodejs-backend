import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createLocalJWKSet,
  errors,
  exportJWK,
  generateKeyPair,
  type JWTVerifyGetKey,
  SignJWT,
} from 'jose';
import {
  FacebookKeysUnavailable,
  InvalidLimitedLoginToken,
  isLimitedLoginToken,
  verifyLimitedLoginToken,
} from './facebookLimitedLogin.js';

// A stand-in for Facebook: its key signs, its public half verifies.
const facebook = await generateKeyPair('RS256');

const someoneElse = await generateKeyPair('RS256');

const keys = createLocalJWKSet({
  keys: [{ ...(await exportJWK(facebook.publicKey)), kid: 'fb', alg: 'RS256' }],
});

function token({
  key = facebook.privateKey,
  issuer = 'https://www.facebook.com',
  expires = '1h',
  claims = {},
}: {
  key?: CryptoKey;
  issuer?: string;
  expires?: string | number;
  claims?: Record<string, unknown>;
} = {}) {
  return new SignJWT({
    name: 'Jana Nováková',
    email: 'jana@example.com',
    picture: 'https://platform-lookaside.fbsbx.com/x.jpg',
    ...claims,
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'fb' })
    .setIssuer(issuer)
    .setAudience('171410630094006')
    .setSubject('12345678901234567')
    .setIssuedAt()
    .setExpirationTime(expires)
    .sign(key);
}

test('verifyLimitedLoginToken: a valid token gives the user', async () => {
  const claims = await verifyLimitedLoginToken(await token(), keys);

  assert.equal(claims.sub, '12345678901234567');
  assert.equal(claims.aud, '171410630094006');
  assert.equal(claims.name, 'Jana Nováková');
  assert.equal(claims.email, 'jana@example.com');
  assert.equal(claims.picture, 'https://platform-lookaside.fbsbx.com/x.jpg');
});

test('verifyLimitedLoginToken: name, email and picture may be missing', async () => {
  const claims = await verifyLimitedLoginToken(
    await token({
      claims: { name: undefined, email: undefined, picture: undefined },
    }),
    keys,
  );

  assert.equal(claims.sub, '12345678901234567');
  assert.equal(claims.email, undefined);
});

for (const [what, make] of [
  ['expired', () => token({ expires: Math.floor(Date.now() / 1000) - 60 })],
  ['signed by another key', () => token({ key: someoneElse.privateKey })],
  ['issued by someone else', () => token({ issuer: 'https://evil.example' })],
  ['not a JWT at all', async () => 'a.b.c'],
] as const) {
  test(`verifyLimitedLoginToken: refuses a token ${what}`, async () => {
    await assert.rejects(
      verifyLimitedLoginToken(await make(), keys),
      InvalidLimitedLoginToken,
    );
  });
}

// What fetching the keys can fail with: jose's plain JOSEError for a non-200
// answer or bad JSON, JWKSInvalid, JWKSTimeout, and fetch's TypeError.
for (const failure of [
  new errors.JOSEError('Expected 200 OK from the JSON Web Key Set'),
  new errors.JWKSInvalid('JSON Web Key Set malformed'),
  new errors.JWKSTimeout(),
  new TypeError('fetch failed'),
]) {
  test(`verifyLimitedLoginToken: ${failure.constructor.name} from the keys is Facebook's`, async () => {
    const failing: JWTVerifyGetKey = () => {
      throw failure;
    };

    await assert.rejects(
      verifyLimitedLoginToken(await token(), failing),
      FacebookKeysUnavailable,
    );
  });
}

test("verifyLimitedLoginToken: an unknown key ID is the token's fault", async () => {
  // the local set answers JWKSNoMatchingKey, as the remote one does after its
  // refetch finds no such key
  const signed = await new SignJWT({})
    .setProtectedHeader({ alg: 'RS256', kid: 'unknown' })
    .setIssuer('https://www.facebook.com')
    .setSubject('1')
    .setExpirationTime('1h')
    .sign(facebook.privateKey);

  await assert.rejects(
    verifyLimitedLoginToken(signed, keys),
    InvalidLimitedLoginToken,
  );
});

test('verifyLimitedLoginToken: an odd email is dropped, not the login', async () => {
  const claims = await verifyLimitedLoginToken(
    await token({ claims: { email: 'not an address' } }),
    keys,
  );

  assert.equal(claims.sub, '12345678901234567');
  assert.equal(claims.email, undefined);
});

test('isLimitedLoginToken: a JWT, not a Graph access token', async () => {
  assert.equal(isLimitedLoginToken(await token()), true);
  assert.equal(isLimitedLoginToken('EAACEdEose0cBAKZA1ZBnoZD'), false);
});
