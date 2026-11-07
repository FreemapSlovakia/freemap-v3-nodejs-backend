// Club event calendars → events; see "AI harvester" in freemap-v3-react's
// doc/events-plan.md. Run: node scripts/harvest-events.mjs [--from=YYYY-MM-DD]
// [--to=YYYY-MM-DD] [--limit=N] [--out=events.json]
// Writes what it would post as JSON; nothing is posted yet.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const USER_AGENT = 'FreemapEventsHarvester/0.1 (+https://www.freemap.sk)';

const API_URL = process.env.API_URL ?? 'https://backend.freemap.sk';

const PHOTON_URL = process.env.PHOTON_URL ?? 'https://photon.freemap.sk';

// Between two requests to the same host.
const DELAY_MS = 2000;

// A detail page is read again after this even when the list entry is unchanged.
const REFETCH_DAYS = 14;

const cacheDir = join(
  dirname(fileURLToPath(import.meta.url)),
  '../data/harvest-events',
);

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .map((arg) => /^--([^=]+)(?:=(.*))?$/.exec(arg))
    .filter(Boolean)
    .map(([, key, value]) => [key, value ?? true]),
);

const today = new Date().toISOString().slice(0, 10);

const date = (name, fallback) => {
  const value = args[name] ?? fallback;

  // The round trip catches 2026-02-30.
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    (value < '9999' && new Date(value).toISOString().slice(0, 10) !== value)
  ) {
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

// Polite fetching

const lastRequest = new Map();

const robotsRules = new Map();

async function politeFetch(url) {
  const { host } = new URL(url);

  // A robots.txt Crawl-delay, when longer, wins.
  const delay = Math.max(DELAY_MS, crawlDelays.get(host) ?? 0);

  const wait = (lastRequest.get(host) ?? 0) + delay - Date.now();

  if (wait > 0) {
    await new Promise((resolve) => setTimeout(resolve, wait));
  }

  lastRequest.set(host, Date.now());

  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });

  if (!res.ok) {
    throw Object.assign(new Error(`${url}: HTTP ${res.status}`), {
      status: res.status,
    });
  }

  return res.text();
}

const crawlDelays = new Map();

/** A robots.txt path pattern: `*` any run, a final `$` the path's end. */
const robotsPattern = (value) =>
  new RegExp(
    `^${value
      .replace(/\$$/, '')
      .replace(/[.+?^{}()|[\]\\]/g, '\\$&')
      .replaceAll('*', '.*')}${value.endsWith('$') ? '$' : ''}`,
  );

/**
 * Throws unless the `User-agent: *` group allows `url`, the longest matching
 * rule winning (RFC 9309); a robots.txt answering 4xx allows everything.
 */
async function assertAllowed(url) {
  const { origin, host, pathname, search } = new URL(url);

  if (!robotsRules.has(origin)) {
    const rules = [];

    try {
      const text = await politeFetch(`${origin}/robots.txt`);

      let applies = false;

      // A group may name several agents on consecutive lines.
      let inAgents = false;

      for (const line of text.split('\n')) {
        const [, key, value] =
          /^\s*([A-Za-z-]+)\s*:\s*(.*?)\s*$/.exec(line.replace(/#.*/, '')) ??
          [];

        if (!key) {
          continue;
        }

        const name = key.toLowerCase();

        if (name === 'user-agent') {
          applies = (inAgents && applies) || value === '*';

          inAgents = true;

          continue;
        }

        inAgents = false;

        if (!applies || !value) {
          continue;
        }

        if (name === 'allow' || name === 'disallow') {
          rules.push({
            allow: name === 'allow',
            length: value.length,
            re: robotsPattern(value),
          });
        } else if (name === 'crawl-delay' && Number(value) > 0) {
          crawlDelays.set(host, Number(value) * 1000);
        }
      }
    } catch (err) {
      if (!(err.status >= 400 && err.status < 500)) {
        throw err;
      }
    }

    robotsRules.set(origin, rules);
  }

  const path = pathname + search;

  const [rule] = robotsRules
    .get(origin)
    .filter((r) => r.re.test(path))
    .toSorted(
      (a, b) => b.length - a.length || Number(b.allow) - Number(a.allow),
    );

  if (rule && !rule.allow) {
    throw new Error(`${url}: disallowed by robots.txt`);
  }
}

// Helpers

const decodeEntities = (s) =>
  s
    .replace(/&nbsp;/g, ' ')
    .replace(/&#0*39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([\da-f]+);/gi, (_, n) =>
      String.fromCodePoint(Number.parseInt(n, 16)),
    )
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

const text = (html) =>
  decodeEntities(html.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();

/** A wall-clock time in `timeZone` as an instant. */
function zonedToIso(date, time, timeZone) {
  const wall = Date.parse(`${date}T${time}:00Z`);

  const format = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });

  /** The zone's offset at instant `t`, in ms. */
  const offsetAt = (t) => {
    const p = Object.fromEntries(
      format.formatToParts(t).map((part) => [part.type, part.value]),
    );

    return (
      Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:00Z`) - t
    );
  };

  // Twice: the offset at the first guess may differ across a DST switch.
  const first = wall - offsetAt(wall);

  return new Date(wall - offsetAt(first)).toISOString();
}

const distanceKm = (a, b) => {
  const rad = Math.PI / 180;

  const x =
    Math.sin(((b.lat - a.lat) * rad) / 2) ** 2 +
    Math.cos(a.lat * rad) *
      Math.cos(b.lat * rad) *
      Math.sin(((b.lon - a.lon) * rad) / 2) ** 2;

  return 12742 * Math.asin(Math.sqrt(x));
};

/** The best Photon hit for `query` in `countrycode`, or null. */
async function geocode(query, countrycode, county) {
  const url = new URL('/api', PHOTON_URL);

  url.searchParams.set('q', query);
  url.searchParams.set('limit', '5');

  const { features } = JSON.parse(await politeFetch(url.href));

  const hit = features.find(
    (f) =>
      f.properties.countrycode === countrycode &&
      (!county || f.properties.county?.includes(county)),
  );

  return hit
    ? { lat: hit.geometry.coordinates[1], lon: hit.geometry.coordinates[0] }
    : null;
}

// KČT (kct.cz): every event in one embedded array, the details per page.

const KCT_TRANSPORTS = [
  [/^Pěší turistika|^Vysokohorská turistika|^Etapový pochod/, 'hiking'],
  [/^Cykloturistika/, 'bike'],
];

// Phrases standing for "anywhere" where a start place is asked; no \b, which
// fails after a non-ASCII letter.
const ANYWHERE =
  /^(individuáln|libovoln|z místa bydliště|odkudkoli|kdekoli|dostředn|hvězdicov)|místo startu si volí/i;

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
function kctRows(html) {
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
function kctWhenWhere(cell = '') {
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

async function harvestKct() {
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
            html: kctDetailBlock(await politeFetch(entry.url)),
          };

          cache[entry.url] = cached;

          if (i % 25 === 24) {
            saveCache();
          }
        }

        results.push(await kctEvent(entry, cached.html));
      } catch (err) {
        console.error(`  ${entry.url}: ${err}`);

        results.push({
          url: entry.url,
          sourceKey: kctSourceKey(entry.url),
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

/** The part of a detail page the event is read from; kept in the cache. */
function kctDetailBlock(html) {
  const button = /<add-to-calendar-button[^>]*>/i.exec(html)?.[0] ?? '';

  const mapa = /var mapa = (\[[^\]]*\]);/.exec(html)?.[1] ?? '[]';

  const start = html.indexOf('fa-map-pin');

  const end = html.indexOf('Přidejte si akci');

  return `${button}\n<!--mapa ${mapa}-->\n${start >= 0 && end > start ? html.slice(start - 20, end) : ''}`;
}

const kctSourceKey = (url) =>
  `kct:${new URL(url).pathname.split('/').filter(Boolean).at(-1)}`;

// A sentence giving a contact, which a private person's would be: an email, a
// phone number, or words introducing one (the name beside them included).
const CONTACT_RE =
  /[\w.+-]+(@|\(at\))[\w-]+(\.[\w-]+)+|\b\d{3}\s?\d{3}\s?\d{3}\b|kontakt|telefon|\btel\.|e\s?[-–]?\s?mail|mobil/i;

async function kctEvent(entry, block) {
  const notes = [];

  const sourceKey = kctSourceKey(entry.url);

  const button = /<add-to-calendar-button[^>]*>/i.exec(block)?.[0] ?? '';

  const attr = (name) =>
    decodeEntities(new RegExp(`\\b${name}="([^"]*)"`).exec(button)?.[1] ?? '');

  const rows = kctRows(block);

  const start = kctWhenWhere(rows.Start);

  const finish = kctWhenWhere(rows['Cíl']);

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
        KCT_TRANSPORTS.filter(([re]) => re.test(t)).map(([, kind]) => kind),
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

// Events entered by hand win over a harvested copy.

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
    const url = new URL('/events', API_URL);

    url.searchParams.set('from', new Date(t).toISOString());
    url.searchParams.set(
      'to',
      new Date(Math.min(t + WINDOW_MS, last)).toISOString(),
    );

    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });

    if (!res.ok) {
      throw new Error(`${url}: HTTP ${res.status}`);
    }

    const page = await res.json();

    if (page.length >= 1000) {
      throw new Error(`${url}: 1000 events or more, some unseen`);
    }

    // Windows overlap by the events spanning their bounds.
    for (const e of page) {
      if (!e.sourceKey) {
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
    : new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Prague' }).format(
        new Date(e.startAt),
      );

async function markDuplicates(results) {
  const existing = await handEnteredEvents(results);

  for (const r of results) {
    if (!r.body) {
      continue;
    }

    const day = startDay(r.body);

    const words = titleWords(r.body.title);

    // Nearby within a day (sources disagree by one), sharing half the shorter
    // title's words: a club may run two events from one place, and
    // "Novoroční výstup" is everywhere.
    const dup = existing.find((e) => {
      if (
        Math.abs(Date.parse(startDay(e)) - Date.parse(day)) > 86_400_000 ||
        distanceKm(e.startPoint, r.body.startPoint) >= 10
      ) {
        return false;
      }

      const other = titleWords(e.title);

      return (
        other.intersection(words).size * 2 >= Math.min(other.size, words.size)
      );
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

const results = await harvestKct();

await markDuplicates(results);

writeFileSync(outPath, `${JSON.stringify(results, null, 2)}\n`);

const count = (pred) => results.filter(pred).length;

console.error(
  `${results.length} events: ${count((r) => r.body && !r.duplicateOf)} new, ` +
    `${count((r) => r.duplicateOf)} duplicates, ${count((r) => !r.body && !r.failed)} without a place, ` +
    `${count((r) => r.failed)} failed; ` +
    `${count((r) => r.body?.dateOnly)} date only → ${outPath}`,
);
