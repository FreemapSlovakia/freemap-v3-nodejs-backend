// KST regions' own calendars, beyond the national yearbook (kst.mjs): yearly
// PDFs or web pages, each found where its publisher puts it and read whole by
// the LLM (llm.mjs), as every region lays it out differently.
// Needs `pdftotext`, `pdfinfo` and `pdftoppm` (poppler-utils) and
// ANTHROPIC_API_KEY.

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertAllowed,
  decodeEntities,
  distanceKm,
  isDate,
  md,
  placeOf,
  politeFetch,
  politeFetchFile,
  zonedToIso,
} from './fetch.mjs';
import { CONTACT_RE } from './kst.mjs';
import { calendarEvents } from './llm.mjs';

const ZSK_PAGE = 'https://kstturiec.sk/kalendare-regionov-zsk/';

/**
 * A calendar kstturiec.sk links for the Žilina kraj's regions and Prievidza:
 * after the region's name, a link per year.
 */
let zskPage;

async function zskCalendar(label, year) {
  // One page for the five regions, fetched once a run.
  zskPage ??= assertAllowed(ZSK_PAGE).then(() => politeFetch(ZSK_PAGE));

  const links = new RegExp(
    `${label}(?:\\s|<br\\s*/?>)*((?:<a [^>]*>[^<]*</a>[\\s,]*)+)`,
    'i',
  ).exec(await zskPage)?.[1];

  const href = links
    ? new RegExp(`<a href="([^"]+)"[^>]*>\\s*${year}\\s*</a>`).exec(links)?.[1]
    : null;

  return href ? new URL(decodeEntities(href), ZSK_PAGE).href : null;
}

/**
 * Each region's calendar: `find(year)` gives its URL, or null; `kind` says
 * what is there — a PDF's text, a PDF of scanned pages, or a web page; a
 * `form(year)` is posted to the page. One not `perYear` is read once, for
 * whatever years it holds.
 */
const REGIONS = [
  {
    id: 'male-karpaty',
    publisher: 'Malé Karpaty a okolie – oblastný turistický kalendár',
    center: { lat: 48.45, lon: 17.35 },
    kind: 'pdf',
    // Two printed pages to a sheet: each half read on its own.
    halves: true,
    async find(year) {
      const api = `https://kbtbratislava.sk/wp-json/wp/v2/media?search=kal${year}&mime_type=application/pdf&per_page=20`;

      await assertAllowed(api);

      // The file's name changes with each upload, newest listed first; the
      // print version is skipped.
      const media = JSON.parse(await politeFetch(api))
        .map((m) => m.source_url)
        .filter((u) => new RegExp(`/kal${year}mk[^/]*\\.pdf$`).test(u))
        .filter((u) => !/_tlac/.test(u));

      return media[0] ?? null;
    },
  },
  {
    id: 'trencin',
    publisher: 'Regionálna rada KST Trenčín – hlavné podujatia',
    center: { lat: 48.95, lon: 18.15 },
    kind: 'pdf',
    async find(year) {
      const page = 'https://www.ksttn.sk/kalendar-akcii/';

      await assertAllowed(page);

      const href = new RegExp(
        `href="([^"]*hlavne-podujatia_${year}[^"]*\\.pdf)"`,
        'i',
      ).exec(await politeFetch(page))?.[1];

      return href ? new URL(decodeEntities(href), page).href : null;
    },
  },
  {
    id: 'kysuce',
    publisher: 'KST región Kysuce (Čadca) – kalendár podujatí',
    center: { lat: 49.43, lon: 18.79 },
    kind: 'pdf',
    find: (year) => zskCalendar('KYSUCE', year),
  },
  {
    id: 'liptov',
    publisher: 'KST Región Liptov – kalendár turistických podujatí',
    center: { lat: 49.08, lon: 19.6 },
    kind: 'pdf',
    find: (year) => zskCalendar('LIPTOV', year),
  },
  {
    id: 'zilina',
    publisher: 'KST región Žilina – kalendár turistických podujatí',
    center: { lat: 49.2, lon: 18.74 },
    kind: 'pdf',
    find: (year) => zskCalendar('ŽILINA', year),
  },
  {
    id: 'orava',
    publisher: 'KST región Orava – kalendár turistických podujatí',
    center: { lat: 49.3, lon: 19.5 },
    kind: 'pdf',
    find: (year) => zskCalendar('Orava', year),
  },
  {
    id: 'prievidza',
    publisher: 'KST región Prievidza – regionálny kalendár',
    center: { lat: 48.77, lon: 18.62 },
    kind: 'pdf',
    find: (year) => zskCalendar('Prievidza', year),
  },
  {
    id: 'turiec',
    publisher: 'Klub slovenských turistov Turiec – kalendár podujatí',
    center: { lat: 49.07, lon: 18.92 },
    // Its pages are pictures, with no text to extract.
    kind: 'scan',
    async find(year) {
      const page = 'https://kstturiec.sk/kalendar-kst-turiec/';

      await assertAllowed(page);

      const href = new RegExp(
        `<a href="([^"]+\\.pdf)"[^>]*>\\s*R?OK\\s*${year}\\s*</a>`,
        'i',
      ).exec(await politeFetch(page))?.[1];

      return href ? new URL(decodeEntities(href), page).href : null;
    },
  },
  {
    id: 'presov',
    publisher: 'KST Región Prešov – podujatia',
    center: { lat: 49.0, lon: 21.24 },
    kind: 'page',
    find: async () => 'http://www.kstpo.sk/index.php?site=4',
    // All of the year's, not only those to come.
    form: (year) => ({ typakcie: '2', rokakcie: String(year) }),
  },
  {
    id: 'kosice',
    publisher: 'Klub turistov mesta Košice – hlavné podujatia',
    center: { lat: 48.72, lon: 21.26 },
    kind: 'page',
    // One page holding this year's and the next.
    perYear: false,
    find: async () => 'https://ktmk.sk/hlavne-podujatie-ktmk/',
  },
  {
    id: 'stara-lubovna',
    publisher: 'KST Stará Ľubovňa – podujatia',
    center: { lat: 49.3, lon: 20.69 },
    kind: 'page',
    perYear: false,
    find: async () => 'https://www.kstsl.sk/podujatia/',
  },
  {
    id: 'roznava',
    publisher: 'Regionálna rada KST Rožňava a Revúca – hlavné podujatia',
    center: { lat: 48.66, lon: 20.53 },
    kind: 'page',
    perYear: false,
    find: async () =>
      'https://rrkstroznava.estranky.sk/clanky/hlavne-podujatia-kst-regionu-roznava-a-revuca-a-kst/',
  },
];

const KINDS = { hiking: 'hiking', bike: 'bike' };

// How far from a region's center its events may be placed.
const REGION_KM = 100;

const SOCIAL_RE = /facebook|instagram|fb\.com|tiktok|x\.com|twitter/i;

/** A multi-day event's last day, if valid. */
const endOf = (e) =>
  e.endDate && isDate(e.endDate) && e.endDate > e.date ? e.endDate : null;

const words = (title) =>
  new Set(
    slug(title)
      .split('-')
      .filter((w) => w.length >= 4),
  );

/** Whether two regions list one event: a day, a place, half the words. */
function sameEvent(a, b) {
  if (
    a.startAt.slice(0, 10) !== b.startAt.slice(0, 10) ||
    distanceKm(a.startPoint, b.startPoint) > 10
  ) {
    return false;
  }

  const wa = words(a.title);

  const wb = words(b.title);

  return wa.intersection(wb).size * 2 >= Math.min(wa.size, wb.size);
}

/** The PDF's text in reading order; a two-pages-a-sheet one half by half. */
function textOf(pdfPath, halves) {
  const run = (args) =>
    execFileSync('pdftotext', ['-layout', ...args, pdfPath, '-'], {
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString();

  if (!halves) {
    return run([]);
  }

  const info = execFileSync('pdfinfo', ['-f', '1', '-l', '9999', pdfPath], {
    stdio: ['ignore', 'pipe', 'ignore'],
  }).toString();

  const pages = [
    ...info.matchAll(/^Page\s+(\d+) size:\s+([\d.]+) x ([\d.]+)/gm),
  ].map(([, n, w, h]) => ({ n, w: Number(w), h: Number(h) }));

  // At pdftotext's 72 dpi, its crop box is in points.
  return pages
    .flatMap(({ n, w, h }) =>
      [0, Math.floor(w / 2)].map((x) =>
        run([
          '-f',
          n,
          '-l',
          n,
          '-x',
          String(x),
          '-y',
          '0',
          '-W',
          String(Math.ceil(w / 2)),
          '-H',
          String(Math.ceil(h)),
        ]),
      ),
    )
    .join('\n');
}

/**
 * A scanned PDF's pages as JPEGs: too big to send whole (over the API's
 * 32 MB), and with no text to extract.
 */
// TODO the cache key is the JPEGs': a poppler update re-renders them
// differently and the scan is read again; and many pages may pass 32 MB.
function imagesOf(pdfPath) {
  const dir = mkdtempSync(join(tmpdir(), 'kst-region-'));

  try {
    execFileSync(
      'pdftoppm',
      // Within the API's 2000 px for a request of many images.
      [
        '-scale-to',
        '1600',
        '-jpeg',
        '-jpegopt',
        'quality=80',
        pdfPath,
        join(dir, 'p'),
      ],
      { stdio: 'ignore' },
    );

    return readdirSync(dir)
      .toSorted()
      .map((f) => readFileSync(join(dir, f)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * A web page's text, one line a block; a line telling today's date ("Dnes je
 * streda, 18.11.2026", "streda, 18.11.2026, Eugen") left out, so the text
 * changes only with the list. An event dated today stays.
 */
function pageText(html, today) {
  const [y, m, d] = today.split('-').map(Number);

  // The whole line: an event's line names more than the day.
  const todayRe = new RegExp(
    `^(dnes je )?(pondelok|utorok|streda|štvrtok|piatok|sobota|nedeľa),? 0?${d}\\. ?0?${m}\\. ?${y}\\.?(, [\\p{L} ]{1,30})?$`,
    'iu',
  );

  return decodeEntities(
    html
      .replace(/<(script|style|nav|footer)\b[\s\S]*?<\/\1>/gi, '')
      .replace(/<[^>]+>/g, '\n'),
  )
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l && !todayRe.test(l.replace(/\.$/, '')))
    .join('\n');
}

const slug = (s) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);

/** An event of the calendar as harvest results go: `{ url, sourceKey, notes, body }`. */
async function resultOf(e, { region, url, year }) {
  const notes = [];

  // A namesake elsewhere in the country is no place of this region's.
  const near = (point) =>
    point && distanceKm(point, region.center) <= REGION_KM ? point : null;

  const town = e.organizerTown
    ? near(
        (await placeOf({ place: null, municipality: e.organizerTown }, 'SK'))
          .point,
      )
    : null;

  const home = town ?? region.center;

  const placed = await placeOf(e, 'SK', home);

  let startPoint = near(placed.point);

  notes.push(startPoint || !placed.point ? placed.note : 'placed too far off');

  let atSummit = null;

  if (!startPoint && e.summit) {
    const summit = await placeOf(
      { place: e.summit, municipality: null },
      'SK',
      home,
    );

    startPoint = near(summit.point);

    if (startPoint) {
      atSummit = e.summit;
    }

    notes.push(`summit: ${summit.note}`);
  }

  // A town to show it at, however rough, rather than not at all.
  if (!startPoint && town) {
    startPoint = town;

    notes.push(`placed at the organizer's home, ${e.organizerTown}`);
  }

  // "8:30" as "08:30".
  const [, hh, mm] = /^(\d{1,2}):(\d{2})$/.exec(e.time ?? '') ?? [];

  const time =
    hh && Number(hh) < 24 && Number(mm) < 60
      ? `${hh.padStart(2, '0')}:${mm}`
      : null;

  const endDate = endOf(e);

  const dateOnly = !time;

  const zoned = (date, t) => zonedToIso(date, t, 'Europe/Bratislava');

  // The prompt asks for no contacts; a sentence still giving one is dropped.
  const details = (e.details ?? '')
    .split(/(?<=[.!?;])\s+/)
    .filter((s) => s && !CONTACT_RE.test(s))
    .join(' ');

  const kms = e.lengthsKm.filter((km) => km > 0 && km < 1000);

  const ascent = e.ascent > 0 && e.ascent < 10000 ? Math.round(e.ascent) : null;

  const description = [
    e.edition ? md(`${e.edition}. ročník.`) : null,
    atSummit
      ? `Miesto stretnutia kalendár neuvádza; na mape je cieľ, ${md(atSummit)}.`
      : null,
    // A person given as the organizer, or a social network's page, isn't shown.
    e.organizer && !CONTACT_RE.test(e.organizer)
      ? `**Organizátor:** ${md(e.organizer)}${
          e.web && !SOCIAL_RE.test(e.web) && !CONTACT_RE.test(e.web)
            ? ` (${md(e.web)})`
            : ''
        }`
      : null,
    details ? md(details) : null,
    `**Zdroj:** ${md(region.publisher)}${year ? ` ${year}` : ''}, ${url}`,
  ]
    .filter(Boolean)
    .join('\n\n');

  return {
    url,
    notes,
    body: startPoint
      ? {
          title: e.title,
          description,
          startAt: dateOnly ? `${e.date}T00:00:00.000Z` : zoned(e.date, time),
          endAt: endDate
            ? dateOnly
              ? `${endDate}T00:00:00.000Z`
              : zoned(endDate, '23:59')
            : null,
          dateOnly,
          startPoint,
          transports: [
            ...new Set(e.kinds.map((k) => KINDS[k]).filter(Boolean)),
          ],
          distance: kms.length ? Math.round(Math.max(...kms) * 1000) : null,
          ascent,
        }
      : null,
  };
}

/**
 * A region's calendar for `year` as `{ url, events }`, or null when it is
 * not published yet.
 */
async function readCalendar(region, year, { perYear, today, cacheDir }) {
  const url = await region.find(year);

  const name = `kst-region-${region.id}-${perYear ? year : 'page'}`;

  const filePath = join(cacheDir, `${name}.pdf`);

  const metaPath = join(cacheDir, `${name}.json`);

  // One not published yet is skipped. One read before and gone now (renamed,
  // moved) fails the run, which would delete its events.
  if (!url) {
    if (existsSync(metaPath)) {
      throw new Error(`${region.id}: the ${year} calendar is gone`);
    }

    console.error(`kst-region ${region.id}: no calendar for ${year}`);

    return null;
  }

  await assertAllowed(url);

  let input;

  if (region.kind === 'page') {
    // A page that went missing answers with an error, failing the run.
    const html = await politeFetch(url, {}, region.form?.(year));

    input = { text: pageText(html, today) };
  } else {
    let meta = {};

    try {
      meta = JSON.parse(readFileSync(metaPath, 'utf8'));
    } catch {
      // Not downloaded yet.
    }

    // A new upload under a new name is a new URL: downloaded afresh, as is one
    // whose file has gone from the cache.
    const file = await politeFetchFile(
      url,
      meta.url === url && existsSync(filePath) ? meta.lastModified : undefined,
    );

    if (file) {
      mkdirSync(cacheDir, { recursive: true });

      writeFileSync(filePath, file.bytes);

      writeFileSync(
        metaPath,
        JSON.stringify({ url, lastModified: file.lastModified }),
      );
    }

    input =
      region.kind === 'scan'
        ? { images: imagesOf(filePath) }
        : { text: textOf(filePath, region.halves) };
  }

  const events = await calendarEvents({
    ...input,
    year: perYear ? year : null,
    publisher: region.publisher,
    cacheDir,
  });

  // Read by nothing else: without the key the run fails, not empties.
  if (!events) {
    throw new Error('no ANTHROPIC_API_KEY');
  }

  const lastPath = join(cacheDir, `${name}-last.json`);

  let lastDate = '';

  try {
    lastDate = JSON.parse(readFileSync(lastPath, 'utf8'));
  } catch {
    // Not read before.
  }

  // Empty while it listed events still to come (a page moved, redesigned or
  // down for maintenance): failed, not emptied. Otherwise none out yet.
  if (!events.length) {
    if (lastDate >= today) {
      throw new Error(`${region.id}: the calendar lists no events now`);
    }

    console.error(`kst-region ${region.id}: no events for ${year} yet`);

    return null;
  }

  mkdirSync(cacheDir, { recursive: true });

  writeFileSync(
    lastPath,
    JSON.stringify(
      events
        .map((e) => e.endDate ?? e.date)
        .filter(isDate)
        .toSorted()
        .at(-1) ?? '',
    ),
  );

  console.error(
    `kst-region ${region.id}${perYear ? ` ${year}` : ''}: ${events.length} events`,
  );

  return { url, events };
}

/** The events from `from` to `to`, each `{ url, sourceKey, notes, body, failed? }`. */
async function harvest({ from, to, limit, today, cacheDir }) {
  const results = [];

  const seen = new Set();

  const year = Number(today.slice(0, 4));

  for (const region of REGIONS) {
    const perYear = region.perYear ?? true;

    // This year's calendar, and next year's once it is out.
    for (const y of perYear ? [year, year + 1] : [year]) {
      let read;

      // A region failing (its site down, its calendar gone) keeps its events
      // and fails the run; the other regions go on.
      try {
        read = await readCalendar(region, y, { perYear, today, cacheDir });
      } catch (err) {
        console.error(`kst-region ${region.id}: ${err}`);

        results.push({
          url: null,
          sourceKey: null,
          keeps: `kst-region:${region.id}:`,
          failed: true,
          notes: [String(err)],
          body: null,
        });

        continue;
      }

      if (!read) {
        continue;
      }

      const { url, events } = read;

      for (const e of events) {
        if (!isDate(e.date) || (perYear && e.date.slice(0, 4) !== String(y))) {
          continue;
        }

        if ((endOf(e) ?? e.date) < from || e.date > to) {
          continue;
        }

        if (results.length >= limit) {
          break;
        }

        // A name on a day is one event; a second one so named, numbered.
        // TODO the title is the LLM's: a calendar read again (a new upload)
        // may word it differently, and the event is reposted under a new id.
        const base = `kst-region:${region.id}:${e.date}:${slug(e.title)}`;

        let sourceKey = base;

        for (let n = 2; seen.has(sourceKey); n++) {
          sourceKey = `${base}-${n}`;
        }

        seen.add(sourceKey);

        try {
          const result = await resultOf(e, {
            region,
            url,
            year: perYear ? y : null,
          });

          // Listed by a region before: that one's copy stands.
          if (
            result.body &&
            results.some((r) => r.body && sameEvent(r.body, result.body))
          ) {
            continue;
          }

          result.sourceKey = sourceKey;

          if (result.body) {
            result.body.sourceKey = sourceKey;
          }

          results.push(result);
        } catch (err) {
          console.error(`  ${e.date} ${e.title}: ${err}`);

          results.push({
            url,
            sourceKey,
            failed: true,
            notes: [String(err)],
            body: null,
          });
        }
      }
    }
  }

  return results;
}

export default {
  key: 'kst-region',
  organizer: {
    name: 'Klub slovenských turistov',
  },
  /** KST's account, as the national yearbook's events are entered for. */
  organizerId: 10879,
  /** Its copies of the yearbook's events give way to them. */
  defersTo: ['kst'],
  harvest,
};
