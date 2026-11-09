// Club event calendars → events; see "Harvester" in freemap-v3-react's
// doc/events-plan.md. Each source is a module in event-sources/.
//
// Run: node scripts/harvest-events.mjs [--source=kct [--organizer-id=N]]
//   [--from=YYYY-MM-DD]
//   [--to=YYYY-MM-DD] [--limit=N] [--out=events.json] [--post]
//   [--create-organizer]
// Without --post it only writes what it would post to --out. --post and
// --create-organizer take an eventManager's app token with events:write in
// FREEMAP_API_TOKEN.

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import datatourisme from './event-sources/datatourisme.mjs';
import dvv from './event-sources/dvv.mjs';
import { daysBetween, isDate, USER_AGENT } from './event-sources/fetch.mjs';
import kct from './event-sources/kct.mjs';
import kst from './event-sources/kst.mjs';
import suedtirol from './event-sources/suedtirol.mjs';
import ttt from './event-sources/ttt.mjs';

const SOURCES = [kct, kst, ttt, datatourisme, dvv, suedtirol];

const API_URL = process.env.API_URL ?? 'https://backend.freemap.sk';

const TOKEN = process.env.FREEMAP_API_TOKEN;

const cacheDir =
  process.env.HARVEST_CACHE_DIR ??
  join(dirname(fileURLToPath(import.meta.url)), '../data/harvest-events');

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .map((arg) => /^--([^=]+)(?:=(.*))?$/.exec(arg))
    .filter(Boolean)
    .map(([, key, value]) => [key, value ?? true]),
);

// The sources' own day, not UTC's, which lags it past midnight.
const today = Temporal.Now.plainDateISO('Europe/Prague').toString();

const date = (name, fallback) => {
  const value = args[name] ?? fallback;

  if (!isDate(value)) {
    throw new Error(`--${name} takes a YYYY-MM-DD date`);
  }

  return value;
};

const from = date('from', today);

const to = date('to', '9999-12-31');

if (from > to) {
  throw new Error('--from is after --to');
}

const limit = args.limit === undefined ? Infinity : Number(args.limit);

if (!(Number.isInteger(limit) && limit > 0) && limit !== Infinity) {
  throw new Error('--limit takes a positive whole number');
}

const outPath = args.out ?? 'events.json';

const sources = args.source
  ? SOURCES.filter((s) => s.key === args.source)
  : SOURCES;

if (!sources.length) {
  throw new Error(`--source is one of ${SOURCES.map((s) => s.key).join(', ')}`);
}

// Another database's account, e.g. a local API's, for the one --source.
if (args['organizer-id'] !== undefined) {
  const id = Number(args['organizer-id']);

  if (!args.source || !Number.isInteger(id) || id <= 0) {
    throw new Error('--organizer-id takes a user id, with --source');
  }

  sources[0] = { ...sources[0], organizerId: id };
}

if ((args.post || args['create-organizer']) && !TOKEN) {
  throw new Error('FREEMAP_API_TOKEN is not set');
}

/** A request to our API as the token's eventManager, or with `anonymous` as nobody. */
async function api(method, path, body, { anonymous = false } = {}) {
  const res = await fetch(new URL(path, API_URL), {
    method,
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'application/json',
      ...(TOKEN && !anonymous && { Authorization: `Bearer ${TOKEN}` }),
      ...(body && { 'Content-Type': 'application/json' }),
    },
    body: body && JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(
      `${method} ${path}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`,
    );
  }

  return res.status === 204 ? null : res.json();
}

if (args['create-organizer']) {
  for (const source of sources) {
    // Once only: a rerun would make another account to merge by hand.
    if (source.organizerId != null) {
      console.error(
        `${source.key}: organizer is user ${source.organizerId} already`,
      );

      continue;
    }

    const { id } = await api('POST', '/events/organizers', source.organizer);

    console.error(
      `${source.key}: organizer "${source.organizer.name}" is user ${id}; set organizerId in its module`,
    );
  }

  process.exit(0);
}

// Events entered by hand win over a harvested copy.

const distanceKm = (a, b) => {
  const rad = Math.PI / 180;

  const x =
    Math.sin(((b.lat - a.lat) * rad) / 2) ** 2 +
    Math.cos(a.lat * rad) *
      Math.cos(b.lat * rad) *
      Math.sin(((b.lon - a.lon) * rad) / 2) ** 2;

  return 12742 * Math.asin(Math.sqrt(x));
};

const titleWords = (title) =>
  new Set(
    title
      .toLowerCase()
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      .split(/[^\p{L}\d]+/u)
      .filter((w) => w.length >= 4),
  );

// A week a request: the API lists 1000 at most, harvested events included.
const WINDOW_MS = 7 * 86_400_000;

/** The public events entered by hand around the harvested days. */
async function handEnteredEvents(results) {
  const starts = results
    .filter((r) => r.body)
    .map((r) => Date.parse(r.body.startAt));

  const events = new Map();

  if (!starts.length) {
    return [];
  }

  // Two days' margin: a duplicate may start a day apart, in any zone.
  const last = Math.max(...starts) + 2 * 86_400_000;

  for (let t = Math.min(...starts) - 2 * 86_400_000; t < last; t += WINDOW_MS) {
    const query = new URLSearchParams({
      from: new Date(t).toISOString(),
      to: new Date(Math.min(t + WINDOW_MS, last)).toISOString(),
    });

    // Anonymously: public ones only, and the token needs no events:read.
    const page = await api('GET', `/events?${query}`, undefined, {
      anonymous: true,
    });

    if (page.length >= 1000) {
      throw new Error(`/events?${query}: 1000 events or more, some unseen`);
    }

    // Windows overlap by the events spanning their bounds. `manual:` ones were
    // imported by hand, from no source a harvest syncs.
    for (const e of page) {
      if (!e.sourceKey || e.sourceKey.startsWith('manual:')) {
        events.set(e.id, e);
      }
    }
  }

  return [...events.values()];
}

/** The calendar day an event starts on: a date-only one's UTC date, else Prague's. */
const startDay = (e) =>
  e.dateOnly
    ? e.startAt.slice(0, 10)
    : Temporal.Instant.from(e.startAt)
        .toZonedDateTimeISO('Europe/Prague')
        .toPlainDate()
        .toString();

async function markDuplicates(results) {
  const existing = (await handEnteredEvents(results)).map((e) => ({
    ...e,
    day: startDay(e),
  }));

  for (const r of results) {
    if (!r.body) {
      continue;
    }

    const day = startDay(r.body);

    const words = titleWords(r.body.title);

    // Within a day (sources disagree by one): within 10 km sharing half the
    // shorter title's words, as a club may run two events from one place and
    // "Novoroční výstup" is everywhere; or within 30 km by the same title, as
    // a source may place the start elsewhere.
    const dup = existing.find((e) => {
      if (Math.abs(daysBetween(e.day, day)) > 1) {
        return false;
      }

      const km = distanceKm(e.startPoint, r.body.startPoint);

      const other = titleWords(e.title);

      const shared = other.intersection(words).size;

      return km < 10
        ? shared * 2 >= Math.min(other.size, words.size)
        : km < 30 && shared === Math.max(other.size, words.size);
    });

    if (dup) {
      r.duplicateOf = {
        id: dup.id,
        title: dup.title,
        organizer: dup.user.name,
        day,
      };
    }
  }
}

/**
 * Posts every event of the source, deletes those gone from it. All, not only
 * the changed: the source is the master, so a hand edit is overwritten and an
 * event deleted here comes back.
 */
async function sync(source, results, complete) {
  if (source.organizerId == null) {
    throw new Error(
      `${source.key}: no organizerId yet; run with --create-organizer first`,
    );
  }

  const stats = { posted: 0, failed: 0, deleted: 0 };

  for (const r of results) {
    if (!r.body || r.duplicateOf) {
      continue;
    }

    try {
      await api('POST', '/events', { ...r.body, userId: source.organizerId });

      stats.posted++;
    } catch (err) {
      console.error(`  ${r.url}: ${err}`);

      stats.failed++;
    }
  }

  // Only a complete run knows what is gone; one cut by --from, --to or
  // --limit doesn't.
  if (!complete) {
    console.error(`${source.key}: not complete, nothing deleted`);

    return stats;
  }

  // Whatever the source still lists is kept, even unread or unplaced this
  // time (a page failing, Photon down); a harvested copy of a hand-entered
  // event goes.
  const kept = new Set(
    results.filter((r) => !r.duplicateOf).map((r) => r.sourceKey),
  );

  const ours = await api(
    'GET',
    `/events/sources/${encodeURIComponent(source.key)}`,
  );

  const gone = ours.filter((e) => !kept.has(e.sourceKey));

  // A source answering with far fewer events is broken, not emptied.
  if (gone.length > Math.max(20, ours.length / 4)) {
    throw new Error(
      `${source.key}: ${gone.length} of ${ours.length} upcoming events would go; not deleting`,
    );
  }

  for (const e of gone) {
    try {
      await api('DELETE', `/events/${encodeURIComponent(e.id)}`);

      stats.deleted++;
    } catch (err) {
      console.error(`  ${e.sourceKey}: ${err}`);

      stats.failed++;
    }
  }

  return stats;
}

const allResults = [];

let failed = false;

for (const source of sources) {
  let results;

  // One broken source doesn't stop the others.
  try {
    results = await source.harvest({ from, to, limit, today, cacheDir });

    await markDuplicates(results);
  } catch (err) {
    console.error(`${source.key}: ${err}`);

    failed = true;

    continue;
  }

  allResults.push(...results);

  const count = (pred) => results.filter(pred).length;

  console.error(
    `${source.key}: ${results.length} events: ${count((r) => r.body && !r.duplicateOf)} new, ` +
      `${count((r) => r.duplicateOf)} duplicates, ${count((r) => !r.body && !r.failed)} without a place, ` +
      `${count((r) => r.failed)} failed; ${count((r) => r.body?.dateOnly)} date only`,
  );

  failed ||= results.some((r) => r.failed);

  if (args.post) {
    try {
      const stats = await sync(
        source,
        results,
        args.from === undefined && args.to === undefined && limit === Infinity,
      );

      console.error(
        `${source.key}: ${stats.posted} posted, ${stats.deleted} deleted, ${stats.failed} failed`,
      );

      failed ||= stats.failed > 0;
    } catch (err) {
      console.error(String(err));

      failed = true;
    }
  }
}

writeFileSync(outPath, `${JSON.stringify(allResults, null, 2)}\n`);

console.error(`→ ${outPath}`);

// A scheduled run shows red for a page not read, an event not posted or
// deleted, a source broken.
if (failed) {
  process.exitCode = 1;
}
