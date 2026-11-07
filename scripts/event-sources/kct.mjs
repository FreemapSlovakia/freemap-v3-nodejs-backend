// KČT (kct.cz): every event in one embedded array, the details per page.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  assertAllowed,
  decodeEntities,
  geocode,
  politeFetch,
  text,
  zonedToIso,
} from './fetch.mjs';

// A detail page is read again after this even when the list entry is unchanged.
const REFETCH_DAYS = 14;

const TRANSPORTS = [
  [/^Pěší turistika|^Vysokohorská turistika|^Etapový pochod/, 'hiking'],
  [/^Cykloturistika/, 'bike'],
];

// Phrases standing for "anywhere" where a start place is asked; no \b, which
// fails after a non-ASCII letter.
const ANYWHERE =
  /^(individuáln|libovoln|z místa bydliště|odkudkoli|kdekoli|dostředn|hvězdicov)|místo startu si volí/i;

// A sentence giving a contact, which a private person's would be: an email, a
// phone number, or words introducing one (the name beside them included).
const CONTACT_RE =
  /[\w.+-]+(@|\(at\))[\w-]+(\.[\w-]+)+|\b\d{3}\s?\d{3}\s?\d{3}\b|kontakt|telefon|\btel\.|e\s?[-–]?\s?mail|mobil/i;

/** Kilometres in "(8, 14, 20 a 35 km)", "(6,7 km)", "(10–30 km)". */
function parseKm(type) {
  const inner = /\(([^)]*\bkm)\)/.exec(type)?.[1];

  if (!inner) {
    return [];
  }

  const body = inner.replace(/\s*km$/, '');

  // One decimal digit after a lone comma is a fraction; otherwise commas list.
  const tokens = /^\s*\d+,\d\s*$/.test(body)
    ? [body.replace(',', '.')]
    : body.split(/,|\ba\b|\baž\b|–|-|\bnebo\b/);

  return tokens.map((t) => Number.parseFloat(t)).filter(Number.isFinite);
}

/** The rows of the detail tables as label → cell HTML. */
function rowsOf(html) {
  const rows = {};

  for (const [, label, cell] of html.matchAll(
    // The label holds no tag but <br>, so a one-cell row before it isn't swallowed.
    /<tr><td[^>]*>([^<]*(?:<br\s*\/?>[^<]*)*)<\/td><td[^>]*>(.*?)<\/td>/gis,
  )) {
    rows[text(label.replace(/<br\s*\/?>.*$/is, ''))] = cell;
  }

  return rows;
}

/** A Start or Cíl cell: its date, time and place lines by their icons. */
function whenWhere(cell = '') {
  const out = {};

  for (const part of cell.split(/(?=<i class=)/i)) {
    const value = text(part);

    if (/fa-calendar-check/.test(part)) {
      const [, d, m, y] = /(\d+)\.\s*(\d+)\.\s*(\d{4})/.exec(value) ?? [];

      if (y) {
        out.date = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
      }
    } else if (/fa-clock/.test(part)) {
      out.time = /\d{1,2}:\d{2}/.exec(value)?.[0].padStart(5, '0');
    } else if (/fa-map-marker-alt/.test(part)) {
      out.place = value;
    } else if (/fa-map-marked-alt/.test(part)) {
      out.county = value.replace(/^okres\s+/, '');
    }
  }

  return out;
}

/** The part of a detail page the event is read from; kept in the cache. */
function detailBlock(html) {
  const button = /<add-to-calendar-button[^>]*>/i.exec(html)?.[0] ?? '';

  const mapa = /var mapa = (\[[^\]]*\]);/.exec(html)?.[1] ?? '[]';

  const start = html.indexOf('fa-map-pin');

  const end = html.indexOf('Přidejte si akci');

  return `${button}\n<!--mapa ${mapa}-->\n${start >= 0 && end > start ? html.slice(start - 20, end) : ''}`;
}

const sourceKeyOf = (url) =>
  `kct:${new URL(url).pathname.split('/').filter(Boolean).at(-1)}`;

async function eventOf(entry, block) {
  const notes = [];

  const sourceKey = sourceKeyOf(entry.url);

  const button = /<add-to-calendar-button[^>]*>/i.exec(block)?.[0] ?? '';

  const attr = (name) =>
    decodeEntities(new RegExp(`\\b${name}="([^"]*)"`).exec(button)?.[1] ?? '');

  const rows = rowsOf(block);

  const start = whenWhere(rows.Start);

  const finish = whenWhere(rows['Cíl']);

  // Each type is an icon's span and a text span.
  const types = [
    ...(rows['Typ akce'] ?? '').matchAll(
      /<span style="display: inline-block;">(?!<img)(.*?)<\/span>/gi,
    ),
  ]
    .map(([, html]) => text(html))
    .filter(Boolean);

  const pin = text(/fa-map-pin"><\/i>([^<]*)/.exec(block)?.[1] ?? '');

  const [coords] = JSON.parse(/<!--mapa (.*?)-->/.exec(block)?.[1] ?? '[]');

  const startDate = start.date || attr('startdate') || entry.start;

  // Without a shown time the button's 05:00 is a placeholder; the finish's
  // time then stays in the description only.
  const startTime = start.time ?? null;

  const dateOnly = !startTime;

  // A date-only event's days as UTC midnights, as the API takes them.
  const startAt = dateOnly
    ? `${startDate}T00:00:00.000Z`
    : zonedToIso(startDate, startTime, 'Europe/Prague');

  const endDate = finish.date || attr('enddate') || startDate;

  let endAt = dateOnly
    ? endDate > startDate
      ? `${endDate}T00:00:00.000Z`
      : null
    : finish.time || endDate !== startDate
      ? zonedToIso(endDate, finish.time ?? '23:59', 'Europe/Prague')
      : null;

  if (dateOnly && endDate < startDate) {
    notes.push('finish before the start, end dropped');
  }

  if (endAt && endAt < startAt) {
    // A night march's "do 02:00" without a date ends the next morning; a
    // later time is a source error, not a day-long march.
    // Without a finish date its time is relative to the start's day.
    const nextDate = new Date(Date.parse(`${startDate}T00:00:00Z`) + 86_400_000)
      .toISOString()
      .slice(0, 10);

    const rolled =
      !finish.date && finish.time && finish.time <= '06:00'
        ? zonedToIso(nextDate, finish.time, 'Europe/Prague')
        : null;

    endAt = rolled && rolled >= startAt ? rolled : null;

    if (!endAt) {
      notes.push('finish before the start, end dropped');
    }
  }

  const named = (place) => (place && !ANYWHERE.test(place) ? place : null);

  const startPlace = named(start.place);

  let startPoint = null;

  const lat = Number(coords?.latitude);

  const lon = Number(coords?.longitude);

  const pinned =
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    /souřadnic (startu|cíle)/.test(pin)
      ? { lat, lon }
      : null;

  const pinnedAtFinish = pinned && /souřadnic cíle/.test(pin);

  if (pinned && !pinnedAtFinish) {
    startPoint = pinned;
  } else {
    // A named start beats the finish's pin; each place only in its own
    // district, a finish without one anywhere. Whole, then up to its first
    // comma: "Pardubice, žst." finds the town.
    const candidates = [
      [startPlace, start.county, false],
      ...(pinned ? [] : [[named(finish.place), finish.county, true]]),
    ]
      .flatMap(([place, county, atFinish]) => [
        [place, county, atFinish],
        [place?.split(',')[0].trim(), county, atFinish],
      ])
      .filter(([place]) => place)
      .filter(
        ([place, county], i, all) =>
          all.findIndex(([p, c]) => p === place && c === county) === i,
      );

    for (const [place, county, atFinish] of candidates) {
      startPoint = await geocode(
        county ? `${place}, ${county}` : place,
        'CZ',
        county,
      );

      if (startPoint) {
        notes.push(
          atFinish
            ? `placed at the finish "${place}"${startPlace ? `, start "${startPlace}" not found` : ''}`
            : `geocoded "${place}"`,
        );

        break;
      }
    }

    if (!startPoint && pinned) {
      startPoint = pinned;

      notes.push(
        `placed at the finish${startPlace ? `, start "${startPlace}" not found` : ''}`,
      );
    } else if (!startPoint) {
      notes.push(
        candidates.length
          ? `not geocoded "${candidates.map(([p]) => p).join('" / "')}"`
          : 'no place',
      );
    }
  }

  const transports = [
    ...new Set(
      types.flatMap((t) =>
        TRANSPORTS.filter(([re]) => re.test(t)).map(([, kind]) => kind),
      ),
    ),
  ];

  const kms = types.flatMap(parseKm);

  const web = text(rows.Web ?? '');

  const webUrl = web
    ? web.replace(/^https?\/\/|^https?:\/\/|^/, 'https://').replace(/\s.*/, '')
    : null;

  // The organizer's note, without contacts: those are on the source page.
  const rawNote = text(rows['Poznámka'] ?? '');

  const note = rawNote
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => !CONTACT_RE.test(sentence))
    .join(' ');

  if (note !== rawNote) {
    notes.push('contacts dropped from the note');
  }

  const edition = text(
    /<td colspan=2[^>]*>(\d+\. ročník)<\/td>/.exec(block)?.[1] ?? '',
  );

  const where = (w) =>
    [
      w.date && w.date !== startDate
        ? w.date.split('-').reverse().map(Number).join('. ')
        : null,
      w.time && `do ${w.time}`,
      w.place,
    ]
      .filter(Boolean)
      .join(', ');

  const description = [
    note || null,
    [
      edition ? `${edition}.` : null,
      start.place || start.county
        ? `**Start:** ${[startTime, start.place, start.county && `okres ${start.county}`].filter(Boolean).join(', ')}`
        : null,
      where(finish) ? `**Cíl:** ${where(finish)}` : null,
    ]
      .filter(Boolean)
      .join('\n\n'),
    types.length
      ? `**Typ akce:**\n${types.map((t) => `- ${t}`).join('\n')}`
      : null,
    `**Pořadatel:** ${text(rows['Pořadatel'] ?? entry.poradatel ?? '')}${webUrl ? ` ([${web.replace(/^https?:?\/\//, '')}](${webUrl}))` : ''}`,
    `**Zdroj:** ${entry.url}`,
  ]
    .filter(Boolean)
    .join('\n\n');

  return {
    url: entry.url,
    sourceKey,
    notes,
    body: startPoint
      ? {
          sourceKey,
          title: attr('name') || decodeEntities(entry.title),
          description,
          startAt,
          endAt,
          dateOnly,
          startPoint,
          visibility: 'public',
          transports,
          distance: kms.length ? Math.round(Math.max(...kms) * 1000) : null,
          children: types.includes('Rodinná turistika') ? true : null,
        }
      : null,
  };
}

/** The events from `from` to `to`, each `{ url, sourceKey, notes, body, failed? }`. */
async function harvest({ from, to, limit, today, cacheDir }) {
  const listUrl = 'https://kct.cz/kalendar-akci/';

  await assertAllowed(listUrl);

  const listHtml = await politeFetch(listUrl);

  const list = JSON.parse(
    /const allEvents = (\[.*?\]);\s*\n/s.exec(listHtml)?.[1] ?? 'null',
  );

  if (!Array.isArray(list)) {
    throw new Error('kct.cz: the calendar no longer embeds allEvents');
  }

  const cachePath = join(cacheDir, 'kct.json');

  let cache = {};

  try {
    cache = JSON.parse(readFileSync(cachePath, 'utf8'));
  } catch {
    // First run.
  }

  const wanted = list
    // Still running counts: a camp begun yesterday is not gone.
    .filter((e) => (e.end || e.start) >= from && e.start <= to)
    .toSorted((a, b) => a.start.localeCompare(b.start))
    .slice(0, limit);

  console.error(`kct.cz: ${list.length} listed, ${wanted.length} in range`);

  // Pages of events over and gone from the list are dropped.
  // The earlier of two date strings, which Math.min can't compare.
  const [keepFrom] = [from, today].toSorted();

  const listed = new Set(
    list.filter((e) => (e.end || e.start) >= keepFrom).map((e) => e.url),
  );

  cache = Object.fromEntries(
    Object.entries(cache).filter(([url]) => listed.has(url)),
  );

  const saveCache = () => {
    mkdirSync(cacheDir, { recursive: true });

    writeFileSync(cachePath, JSON.stringify(cache));
  };

  const results = [];

  try {
    for (const [i, entry] of wanted.entries()) {
      const listKey = `${entry.title}|${entry.start}|${entry.end}`;

      // One bad page is noted and skipped; `failed` keeps its event from
      // counting as gone from the source.
      try {
        let cached = cache[entry.url];

        if (
          !cached ||
          cached.listKey !== listKey ||
          Date.now() - cached.fetchedAt > REFETCH_DAYS * 86_400_000
        ) {
          await assertAllowed(entry.url);

          console.error(`  [${i + 1}/${wanted.length}] ${entry.url}`);

          cached = {
            listKey,
            fetchedAt: Date.now(),
            html: detailBlock(await politeFetch(entry.url)),
          };

          cache[entry.url] = cached;

          if (i % 25 === 24) {
            saveCache();
          }
        }

        results.push(await eventOf(entry, cached.html));
      } catch (err) {
        console.error(`  ${entry.url}: ${err}`);

        results.push({
          url: entry.url,
          sourceKey: sourceKeyOf(entry.url),
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
  key: 'kct',
  /** For `--create-organizer`; its id then goes into `organizerId`. */
  organizer: {
    name: 'Klub českých turistů',
    pictureUrl: 'https://kct.cz/wp-content/uploads/2025/02/logo_kct_web.png',
  },
  /** The account the events are entered for, on www.freemap.sk. */
  organizerId: 10878,
  harvest,
};
