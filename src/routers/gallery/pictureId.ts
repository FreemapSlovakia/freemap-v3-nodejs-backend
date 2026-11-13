import type { ParameterizedContext } from 'koa';
import z from 'zod';

/**
 * A picture id from the `/gallery/pictures/:id` routes. A plain number refers to
 * an own gallery photo; a `w`-prefixed number (e.g. `w12345`) refers to a
 * Wikimedia Commons photo by its stable Commons pageId.
 */
export type PictureRef =
  | { source: 'gallery'; id: number }
  | { source: 'wikimedia'; pageId: number };

/** The `/pictures/{id}` path parameter as the routes taking either accept it. */
export const PictureIdParamSchema = z
  .string()
  .regex(/^w?\d+$/)
  .describe(
    'An own photo by its id, or a Wikimedia Commons one as `w<pageId>`',
  );

// Both columns are `int unsigned`: a longer number is no picture, not Infinity.
const MAX_ID = 0xffff_ffff;

export function parsePictureId(raw: string): PictureRef | null {
  const [, w, digits] = /^(w?)(\d{1,10})$/.exec(raw) ?? [];

  const id = Number(digits);

  if (digits === undefined || id > MAX_ID) {
    return null;
  }

  return w ? { source: 'wikimedia', pageId: id } : { source: 'gallery', id };
}

type PictureContext = Pick<ParameterizedContext, 'throw'> & {
  params: Record<string, string | undefined>;
};

/**
 * The own gallery photo a route that serves or changes only those is asked
 * for. A Commons photo is refused 405 where it exists but the method is not
 * for it (`methodNotFor`), else 404; anything else is no picture.
 */
export function galleryPictureId(
  ctx: PictureContext,
  methodNotFor = false,
): number {
  const ref = parsePictureId(ctx.params.id ?? '');

  if (ref?.source === 'gallery') {
    return ref.id;
  }

  if (ref && methodNotFor) {
    return ctx.throw(405, 'a Wikimedia Commons photo is read-only here', {
      headers: { Allow: 'GET' },
    });
  }

  return ctx.throw(404, 'no such picture');
}
