import sql, { join, raw, type Sql } from 'sql-template-tag';
import type { EventFilter } from '../../eventFilter.js';
import { eventEndSql, importedSql } from './types.js';

/** The range conditions on one stat column. */
function range(column: string, min?: number, max?: number) {
  return [
    ...(min === undefined ? [] : [sql`${raw(column)} >= ${min}`]),
    ...(max === undefined ? [] : [sql`${raw(column)} <= ${max}`]),
  ];
}

/** The condition on one column, or it unset where `unsaid` lets that through. */
function orUnsaid(column: string, conds: Sql[], unsaid: boolean): Sql[] {
  if (conds.length === 0) {
    return [];
  }

  const all = sql`(${join(conds, ' AND ')})`;

  return [unsaid ? sql`(${raw(column)} IS NULL OR ${all})` : all];
}

/** Starting within `radius` km of a place: the box the index serves, then the exact distance. */
export function nearSql(lat: number, lon: number, radius: number): Sql[] {
  const dLat = radius / 111.2;

  const dLon =
    radius / (111.2 * Math.max(Math.cos((lat * Math.PI) / 180), 0.01));

  return [
    sql`e.startLat BETWEEN ${lat - dLat} AND ${lat + dLat}`,
    sql`e.startLon BETWEEN ${lon - dLon} AND ${lon + dLon}`,
    sql`ST_Distance_Sphere(POINT(e.startLon, e.startLat), POINT(${lon}, ${lat})) <= ${radius * 1000}`,
  ];
}

/**
 * What a filter asks of an event besides time and place, as conditions on
 * `e` and its owner `u`; `GET /events` and the saved filters' mail share it.
 */
export function attributesSql(
  f: Pick<
    EventFilter,
    | 'transport'
    | 'distance'
    | 'duration'
    | 'ascent'
    | 'difficulty'
    | 'dogs'
    | 'children'
    | 'imported'
    | 'unsaid'
  >,
): Sql[] {
  const unsaid = Boolean(f.unsaid);

  return [
    // Any of them.
    ...orUnsaid(
      'e.transports',
      f.transport?.length
        ? [
            sql`(${join(
              f.transport.map((t) => sql`FIND_IN_SET(${t}, e.transports)`),
              ' OR ',
            )})`,
          ]
        : [],
      unsaid,
    ),
    ...orUnsaid(
      'e.distance',
      range('e.distance', f.distance?.min, f.distance?.max),
      unsaid,
    ),
    ...orUnsaid(
      'e.duration',
      range('e.duration', f.duration?.min, f.duration?.max),
      unsaid,
    ),
    ...orUnsaid(
      'e.ascent',
      range('e.ascent', f.ascent?.min, f.ascent?.max),
      unsaid,
    ),
    ...orUnsaid(
      'e.difficulty',
      f.difficulty?.length
        ? [sql`e.difficulty IN (${join(f.difficulty)})`]
        : [],
      unsaid,
    ),
    // A yes or no is asked for, so "not said" never matches here.
    ...(f.dogs === undefined ? [] : [sql`e.dogs = ${Number(f.dogs)}`]),
    ...(f.children === undefined
      ? []
      : [sql`e.children = ${Number(f.children)}`]),
    ...(f.imported === undefined
      ? []
      : [f.imported ? importedSql : sql`NOT ${importedSql}`]),
  ];
}

/**
 * The last instant of a period from `now`, as the web counts it: a week is
 * today and the 6 days after; a month ends the day before the same date,
 * clamped to the month's end. Today is the server's local day, as it is the
 * browser's on the web; the end is a UTC day, as the web's picked dates.
 */
export function withinEnd(
  within: NonNullable<EventFilter['within']>,
  now: Date,
): Date {
  const n = Number(within.slice(0, -1));

  const y = now.getFullYear();

  const m = now.getMonth();

  const d = now.getDate();

  const lastDay = within.endsWith('w')
    ? Date.UTC(y, m, d + 7 * n - 1)
    : Date.UTC(
        y,
        m + n,
        Math.min(d - 1, new Date(Date.UTC(y, m + n + 1, 0)).getUTCDate()),
      );

  return new Date(lastDay + 86_400_000 - 1);
}

/**
 * A saved filter as conditions on `e` and its owner `u`, as of `now`: what
 * has not ended by `since`, within its period if it has one.
 */
export function savedFilterSql(f: EventFilter, now: Date, since = now): Sql[] {
  return [
    // As JS dates, not NOW(): the columns hold UTC, the session may not.
    sql`${eventEndSql} >= ${since}`,
    ...(f.within ? [sql`e.startAt <= ${withinEnd(f.within, now)}`] : []),
    ...(f.near ? nearSql(f.near.lat, f.near.lon, f.near.radius) : []),
    ...attributesSql(f),
  ];
}
