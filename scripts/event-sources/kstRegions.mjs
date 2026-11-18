// KST regions' own yearly calendars (PDF), beyond the national yearbook
// (kst.mjs): each found where its publisher puts it, its text read whole by the
// LLM (llm.mjs), as every region lays it out differently.
// Needs `pdftotext` and `pdfinfo` (poppler-utils) and ANTHROPIC_API_KEY.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

/** Each region's calendar: `find(year)` gives its PDF's URL, or null. */
const REGIONS = [
  {
    id: 'male-karpaty',
    publisher: 'Malé Karpaty a okolie – oblastný turistický kalendár',
    center: { lat: 48.45, lon: 17.35 },
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
    halves: false,
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
    `**Zdroj:** ${md(region.publisher)} ${year}, ${url}`,
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

/** The events from `from` to `to`, each `{ url, sourceKey, notes, body, failed? }`. */
async function harvest({ from, to, limit, today, cacheDir }) {
  const results = [];

  const seen = new Set();

  const year = Number(today.slice(0, 4));

  for (const region of REGIONS) {
    // This year's calendar, and next year's once it is out.
    for (const y of [year, year + 1]) {
      const url = await region.find(y);

      const pdfPath = join(cacheDir, `kst-region-${region.id}-${y}.pdf`);

      const metaPath = join(cacheDir, `kst-region-${region.id}-${y}.json`);

      // One not published yet is skipped. One read before and gone now
      // (renamed, moved) fails the run, which would delete its events.
      if (!url) {
        if (existsSync(metaPath)) {
          throw new Error(`${region.id}: the ${y} calendar is gone`);
        }

        console.error(`kst-region ${region.id}: no calendar for ${y}`);

        continue;
      }

      let meta = {};

      try {
        meta = JSON.parse(readFileSync(metaPath, 'utf8'));
      } catch {
        // Not downloaded yet.
      }

      await assertAllowed(url);

      // A new upload under a new name is a new URL: downloaded afresh, as is
      // one whose file has gone from the cache.
      const file = await politeFetchFile(
        url,
        meta.url === url && existsSync(pdfPath) ? meta.lastModified : undefined,
      );

      if (file) {
        mkdirSync(cacheDir, { recursive: true });

        writeFileSync(pdfPath, file.bytes);

        writeFileSync(
          metaPath,
          JSON.stringify({ url, lastModified: file.lastModified }),
        );
      }

      const events = await calendarEvents({
        text: textOf(pdfPath, region.halves),
        year: y,
        publisher: region.publisher,
        cacheDir,
      });

      // Read by nothing else: without the key the run fails, not empties.
      if (!events) {
        throw new Error('no ANTHROPIC_API_KEY');
      }

      console.error(`kst-region ${region.id} ${y}: ${events.length} events`);

      for (const e of events) {
        if (!isDate(e.date) || e.date.slice(0, 4) !== String(y)) {
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
          const result = await resultOf(e, { region, url, year: y });

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
