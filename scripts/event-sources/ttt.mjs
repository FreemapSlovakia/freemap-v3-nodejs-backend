// TTT's calendar of Hungarian long-distance hikes (teljesítménytúra), from the
// JSON API its own pages read: the list for the dates, one occasion's detail
// for its routes' places, ascents and organizer. No LLM: it is all structured.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertAllowed, politeFetch, text, zonedToIso } from './fetch.mjs';

const API = 'https://tturak.hu/api';

const REFETCH_DAYS = 7;

// The route types (params of type "type"); the others say no transport.
const KINDS = { 1: 'hiking', 3: 'bike', 4: 'mtb' };

// A sentence giving a contact: an email, a phone number, words introducing one.
const CONTACT_RE =
  /[\w.+-]+(@|\(at\))[\w-]+(\.[\w-]+)+|\+?36[\s/-]*\d|\b\d{2}[\s/-]\d{3}[\s/-]?\d{3,4}\b|telefon|\btel\.|e-?mail|mobil/i;

const clock = new Intl.DateTimeFormat('hu-HU', {
  timeZone: 'Europe/Budapest',
  hour: '2-digit',
  minute: '2-digit',
});

const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Budapest' });

const at = (seconds) => new Date(seconds * 1000);

const pageOf = (id) => `https://tturak.hu/hikeOccasion/${id}/details`;

async function api(path) {
  const url = `${API}/${path}`;

  await assertAllowed(url);

  return JSON.parse(await politeFetch(url));
}

/** A route's line: its name, length, ascent, start window and places. */
function routeLine(route, typeNames) {
  const start = route.startTimeFrom
    ? [route.startTimeFrom, route.startTimeTo]
        .filter(Boolean)
        .map((s) => clock.format(at(s)))
        .filter((t, i, all) => all.indexOf(t) === i)
        .join('–')
    : null;

  const types = route.params
    .map((p) => typeNames[p])
    .filter((t) => t && t !== typeNames[1]);

  return [
    `**${route.name}**`,
    // Unless its name says it, as "Rövid táv: 13 km".
    route.distance && !/\d\s*km/i.test(route.name)
      ? `${(route.distance / 1000).toLocaleString('hu-HU')} km`
      : null,
    route.ascent ? `↗ ${route.ascent} m` : null,
    types.length ? types.join(', ') : null,
    start ? `rajt ${start}` : null,
    route.startPlace?.name,
    route.round
      ? 'körtúra'
      : route.finishPlace?.name && `cél: ${route.finishPlace.name}`,
    route.price ? `${route.price} ${route.currency}` : null,
  ]
    .filter(Boolean)
    .join(', ');
}

function eventOf(detail, typeNames) {
  const sourceKey = `ttt:${detail.id}`;

  const url = pageOf(detail.id);

  const notes = [];

  const days = [detail.date, detail.dateTo ?? detail.date].map((s) =>
    day.format(at(s)),
  );

  const onto = (date, s) =>
    Date.parse(zonedToIso(date, clock.format(at(s)), 'Europe/Budapest')) / 1000;

  // The occasion's date wins: a route's times may keep a day it moved from,
  // or last year's. A cutoff past midnight, of a night hike, is no such slip.
  const fixTimes = (r) => {
    if (!r.startTimeFrom) {
      return r;
    }

    const outside = (s) =>
      day.format(at(s)) < days[0] || day.format(at(s)) > days[1];

    const from = outside(r.startTimeFrom)
      ? onto(days[0], r.startTimeFrom)
      : r.startTimeFrom;

    const to =
      r.startTimeTo && outside(r.startTimeTo)
        ? onto(day.format(at(from)), r.startTimeTo)
        : r.startTimeTo;

    let cutoff = r.cutoffTime;

    if (cutoff && (cutoff < from || cutoff > from + 2 * 86_400)) {
      cutoff = onto(day.format(at(from)), cutoff);

      if (cutoff < from) {
        cutoff += 86_400;
      }
    }

    if (
      from !== r.startTimeFrom ||
      to !== r.startTimeTo ||
      cutoff !== r.cutoffTime
    ) {
      notes.push(`route ${r.id}: times moved onto ${day.format(at(from))}`);
    }

    return { ...r, startTimeFrom: from, startTimeTo: to, cutoffTime: cutoff };
  };

  // A point outside Europe is a placeholder, as 1, 1.
  const placed = (p) =>
    p?.latitude >= 34 &&
    p.latitude <= 72 &&
    p.longitude >= -25 &&
    p.longitude <= 45;

  const routes = detail.routes.filter((r) => !r.canceled).map(fixTimes);

  // The longest route's start: the one most come for.
  const main = routes
    .filter((r) => placed(r.startPlace))
    .toSorted((a, b) => (b.distance ?? 0) - (a.distance ?? 0))[0];

  if (!main) {
    notes.push('no route with a start place');
  }

  const starts = routes.map((r) => r.startTimeFrom).filter(Boolean);

  const cutoffs = routes.map((r) => r.cutoffTime).filter(Boolean);

  const dateOnly = starts.length === 0;

  const startAt = dateOnly
    ? `${day.format(at(detail.date))}T00:00:00.000Z`
    : at(Math.min(...starts)).toISOString();

  const endAt = dateOnly
    ? detail.dateTo && detail.dateTo !== detail.date
      ? `${day.format(at(detail.dateTo))}T00:00:00.000Z`
      : null
    : cutoffs.length && Math.max(...cutoffs) > Math.min(...starts)
      ? at(Math.max(...cutoffs)).toISOString()
      : null;

  // The organizer's note, without contacts: those are on the source page.
  const rawNote = text(detail.description ?? '');

  const note = rawNote
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => !CONTACT_RE.test(sentence))
    .join(' ');

  if (note !== rawNote) {
    notes.push('contacts dropped from the note');
  }

  const web = detail.organizer?.webpage?.trim();

  const webUrl = web && (/^https?:\/\//.test(web) ? web : `https://${web}`);

  const description = [
    note || null,
    routes.length
      ? `**Távok:**\n${routes.map((r) => `- ${routeLine(r, typeNames)}`).join('\n')}`
      : null,
    detail.organizer?.name
      ? `**Rendező:** ${detail.organizer.name}${webUrl ? ` ([${web.replace(/^https?:\/\//, '').replace(/\/$/, '')}](${webUrl}))` : ''}`
      : null,
    `**Forrás:** TTT Teljesítménytúra Naptár, ${url}`,
  ]
    .filter(Boolean)
    .join('\n\n');

  const distances = routes.map((r) => r.distance).filter(Boolean);

  const ascents = routes.map((r) => r.ascent).filter(Boolean);

  return {
    url,
    sourceKey,
    notes,
    body: main
      ? {
          sourceKey,
          title: detail.name.trim(),
          description,
          startAt,
          endAt,
          dateOnly,
          startPoint: {
            lat: main.startPlace.latitude,
            lon: main.startPlace.longitude,
          },
          visibility: 'public',
          transports: [
            ...new Set(routes.flatMap((r) => r.params.map((p) => KINDS[p]))),
          ].filter(Boolean),
          distance: distances.length ? Math.max(...distances) : null,
          ascent: ascents.length ? Math.max(...ascents) : null,
        }
      : null,
  };
}

/** The events from `from` to `to`, each `{ url, sourceKey, notes, body, failed? }`. */
async function harvest({ from, to, limit, cacheDir }) {
  const fromS = Date.parse(from) / 1000;

  const toS = to < '9999' ? Date.parse(to) / 1000 + 86_399 : null;

  // Every occasion since 2017 comes back whatever the dates asked, so they
  // are filtered here; still running counts.
  const list = await api(
    `hikeoccasion/list?from=${fromS}${toS ? `&to=${toS}` : ''}`,
  );

  if (!Array.isArray(list)) {
    throw new Error('tturak.hu: the occasion list is not an array');
  }

  const wanted = list
    .filter(
      (o) =>
        !o.canceled &&
        !o.archived &&
        (o.dateTo ?? o.date) + 86_399 >= fromS &&
        (toS === null || o.date <= toS),
    )
    .toSorted((a, b) => a.date - b.date)
    .slice(0, limit);

  console.error(`tturak.hu: ${list.length} listed, ${wanted.length} in range`);

  const params = await api('hikeparams/all?v4');

  const typeNames = Object.fromEntries(
    Object.values(params.type ?? {}).map((p) => [p.id, p.localization?.hu]),
  );

  const cachePath = join(cacheDir, 'ttt.json');

  let cache = {};

  try {
    cache = JSON.parse(readFileSync(cachePath, 'utf8'));
  } catch {
    // First run.
  }

  // Details of occasions no longer wanted are dropped.
  const ids = new Set(wanted.map((o) => String(o.id)));

  cache = Object.fromEntries(
    Object.entries(cache).filter(([id]) => ids.has(id)),
  );

  const saveCache = () => {
    mkdirSync(cacheDir, { recursive: true });

    writeFileSync(cachePath, JSON.stringify(cache));
  };

  const results = [];

  try {
    for (const [i, occasion] of wanted.entries()) {
      // The list's date and route count tell a change; else a week's age.
      const listKey = `${occasion.date}|${occasion.routes.length}`;

      try {
        let cached = cache[occasion.id];

        if (
          !cached ||
          cached.listKey !== listKey ||
          Date.now() - cached.fetchedAt > REFETCH_DAYS * 86_400_000
        ) {
          console.error(`  [${i + 1}/${wanted.length}] ${pageOf(occasion.id)}`);

          cached = {
            listKey,
            fetchedAt: Date.now(),
            detail: await api(`hikeoccasion/${occasion.id}`),
          };

          cache[occasion.id] = cached;

          if (i % 25 === 24) {
            saveCache();
          }
        }

        results.push(eventOf(cached.detail, typeNames));
      } catch (err) {
        console.error(`  ${pageOf(occasion.id)}: ${err}`);

        results.push({
          url: pageOf(occasion.id),
          sourceKey: `ttt:${occasion.id}`,
          failed: true,
          notes: [String(err)],
          body: null,
        });
      }
    }
  } finally {
    saveCache();
  }

  return results;
}

export default {
  key: 'ttt',
  /** For `--create-organizer`; its id then goes into `organizerId`. */
  organizer: {
    name: 'Teljesítménytúrázók Társasága',
    pictureUrl:
      'https://www.teljesitmenyturazoktarsasaga.hu/themes/ttt/images/ttt_logo1.jpg',
  },
  /** The account the events are entered for, on www.freemap.sk. */
  organizerId: 10886,
  harvest,
};
