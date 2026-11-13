import type { ParameterizedContext } from 'koa';

// The range of the `INT UNSIGNED` id columns.
const MAX_ID = 0xffff_ffff;

/**
 * A decimal id an `INT UNSIGNED` column can hold, else null. Not `Number()`,
 * which takes `1e3`, `0x10` and ` 12`; nor the raw string, which MariaDB
 * coerces (`12abc` is 12).
 */
export function parseId(raw: string | undefined): number | null {
  if (raw === undefined || !/^\d{1,10}$/.test(raw)) {
    return null;
  }

  const id = Number(raw);

  return id <= MAX_ID ? id : null;
}

export type ParamsContext = Pick<ParameterizedContext, 'throw'> & {
  params: Record<string, string | undefined>;
};

/** The route's `name` parameter as an id; one that isn't is no such record. */
export function idParam(
  ctx: ParamsContext,
  notFound: string,
  name = 'id',
): number {
  return parseId(ctx.params[name]) ?? ctx.throw(404, notFound);
}
