import assert from 'node:assert/strict';
import test from 'node:test';
import { galleryPictureId } from './pictureId.js';

// Throws as Koa's would, with the status and the props set on the error.
const ctx = (id: string) =>
  ({
    params: { id },
    throw(status: number, message: string, props?: object): never {
      throw Object.assign(new Error(message), { status, ...props });
    },
  }) as unknown as Parameters<typeof galleryPictureId>[0];

test('an own photo by its number', () => {
  assert.equal(galleryPictureId(ctx('12')), 12);
});

test('a Commons photo: 405 where only the method is wrong, else 404', () => {
  assert.throws(() => galleryPictureId(ctx('w12'), true), {
    status: 405,
    headers: { Allow: 'GET' },
  });

  assert.throws(() => galleryPictureId(ctx('w12')), { status: 404 });
});

// MySQL would read `12abc` as 12.
test('no picture for an id that is none', () => {
  for (const id of ['12abc', 'abc', '', '-1', '1.5']) {
    assert.throws(() => galleryPictureId(ctx(id), true), { status: 404 });
  }
});

test('an id is a number the column can hold', () => {
  assert.equal(galleryPictureId(ctx('012')), 12);

  assert.equal(galleryPictureId(ctx('4294967295')), 4294967295);

  for (const id of ['4294967296', '9'.repeat(400), 'w4294967296']) {
    assert.throws(() => galleryPictureId(ctx(id), true), { status: 404 });
  }
});
