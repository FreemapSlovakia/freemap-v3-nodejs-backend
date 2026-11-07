// KST (kst.sk): the yearly "Ročenka a kalendár" PDF. Each event is one text
// block written to the yearbook's own template: date; edition and name; kind
// of hiking and km; club and region; "Info:" contact; route and start in prose.
// The meeting place alone is read by the LLM (llm.mjs).
// Needs `pdftotext` (poppler-utils).

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  assertAllowed,
  decodeEntities,
  placeOf,
  politeFetchFile,
  zonedToIso,
} from './fetch.mjs';
import { meetingPlace } from './llm.mjs';

const pdfUrl = (year) =>
  `https://www.kst.sk/userfiles/file/${year}/KST_Rocenka_a_Kalendar_KST_${year}.pdf`;

// The yearbook's abbreviations; L (skiing), V (water), J (riding) have no
// transport kind here.
const KINDS = {
  P: ['pešia', 'hiking'],
  C: ['cyklo', 'bike'],
  L: ['lyžiarska'],
  H: ['vysokohorská', 'hiking'],
  V: ['vodná'],
  J: ['jazdecká'],
  M: ['M'],
};

const MONTHS =
  /^(január|február|marec|apríl|máj|jún|júl|august|september|október|november|december)$/i;

const DATE =
  /^(\d{1,2})\.\s*(?:(\d{1,2})\.?\s*)?(?:(\d{4})\s*)?(?:[–-]\s*(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})|)$/;

const MODE = /^([PCLHVJM](?:\s*,\s*[PCLHVJM])*)\s*[–-]\s*(.*)$/;

// A sentence giving a contact, which a private person's would be: an email, a
// phone number, words introducing one, or a postal address.
const CONTACT_RE =
  /[\w.+-]+(@|\(at\))[\w-]+(\.[\w-]+)+|\b\d{3}\s?\d{3}\s?\d{3}\b|\+?421\d{9}|kontakt|telefon|\btel\.|e\s?[-–]?\s?mail|mobil|vedúc|\b\d{3}\s?\d{2}\s+\p{Lu}/iu;

// Sentences saying where and when participants meet.
const START_RE =
  /miesto zrazu|zraz|stretnutie|štart|odchod|registrácia|prezentácia|sraz/i;

/** The calendar pages' text blocks, each `{ page, column, y, lines }`. */
function blocksOf(pdfPath) {
  const xml = execFileSync('pdftotext', ['-bbox-layout', pdfPath, '-'], {
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  }).toString();

  const blocks = [];

  let inCalendar = false;

  for (const [i, [, width, page]] of [
    ...xml.matchAll(/<page width="([\d.]+)"[^>]*>([\s\S]*?)<\/page>/g),
  ].entries()) {
    const pageBlocks = [
      ...page.matchAll(
        /<block xMin="([\d.]+)" yMin="([\d.]+)"[^>]*>([\s\S]*?)<\/block>/g,
      ),
    ].map(([, x, y, body]) => ({
      page: i + 1,
      // Four columns a page.
      column: Math.floor(Number(x) / (Number(width) / 4)),
      y: Number(y),
      lines: [...body.matchAll(/<line[^>]*>([\s\S]*?)<\/line>/g)].map((l) =>
        decodeEntities(
          [...l[1].matchAll(/>([^<]*)<\/word>/g)].map((w) => w[1]).join(' '),
        )
          .replace(/¬/g, '')
          .trim(),
      ),
    }));

    const text = pageBlocks.flatMap((b) => b.lines).join('\n');

    if (/Kalendár turistických podujatí KST v roku/.test(text)) {
      inCalendar = true;
    }

    if (/REGIONÁLNE KALENDÁRE/.test(text)) {
      break;
    }

    if (inCalendar) {
      blocks.push(
        ...pageBlocks.toSorted((a, b) => a.column - b.column || a.y - b.y),
      );
    }
  }

  return blocks;
}

/** Page furniture: numbers, running titles, month headings. */
const isFurniture = (lines) =>
  lines.length <= 2 &&
  lines.every(
    (l) =>
      /^\d{1,3}$/.test(l) ||
      /^Ročenka a kalendár KST/.test(l) ||
      /^Kalendár turistických podujatí/.test(l) ||
      MONTHS.test(l),
  );

/**
 * Each event's lines. A block not starting with a date continues the event
 * before it, when it heads the next column or page and that event ended its
 * own; anything else (an advert, a box) is dropped.
 */
function eventLines(blocks) {
  const events = [];

  for (const [i, block] of blocks.entries()) {
    if (isFurniture(block.lines)) {
      continue;
    }

    // A block may hold several events, each starting at a date line.
    const groups = [];

    for (const line of block.lines) {
      if (DATE.test(line) || !groups.length) {
        groups.push([]);
      }

      groups.at(-1).push(line);
    }

    for (const [g, lines] of groups.entries()) {
      if (DATE.test(lines[0])) {
        events.push({ page: block.page, lines });

        continue;
      }

      const prev = blocks[i - 1];

      const headsColumn =
        g === 0 &&
        prev &&
        (prev.page !== block.page || prev.column !== block.column);

      if (headsColumn && events.length) {
        events.at(-1).lines.push(...lines);
      }
    }
  }

  return events;
}

const iso = (y, m, d) =>
  `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/** "3. 1. 2026", "29. 1 – 1. 2. 2026" as start and end dates. */
function parseDate(line, year) {
  const [, d1, m1, y1, d2, m2, y2] = DATE.exec(line);

  if (d2) {
    // "30. 12. – 2. 1. 2027": a start month past the end's is the year before.
    const startYear =
      y1 ?? (m1 && Number(m1) > Number(m2) ? Number(y2) - 1 : y2);

    return {
      start: iso(startYear, m1 ?? m2, d1),
      end: iso(y2, m2, d2),
    };
  }

  return m1 ? { start: iso(y1 ?? year, m1, d1), end: null } : null;
}

const slugOf = (s) =>
  s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

/**
 * The event's key from its date, name and club — not from what the LLM says,
 * so an event that fails this run still keeps its key and isn't taken for
 * gone. The club tells apart two "Novoročný výstup" on one day.
 */
function sourceKeyOf(lines, year) {
  const { start } = parseDate(lines[0], year);

  let i = 1;

  const title = [];

  while (i < lines.length && !MODE.test(lines[i]) && !/^Info:/.test(lines[i])) {
    title.push(lines[i++]);
  }

  if (MODE.test(lines[i] ?? '')) {
    i++;
  }

  const club = lines[i] && !/^Info:/.test(lines[i]) ? lines[i] : '';

  const name = title
    .join(' ')
    .replace(/^\d+\.\s*/, '')
    .replace(/\s*\(.*$/, '');

  return `kst:${start}-${slugOf(name).slice(0, 80) || 'event'}-${slugOf(club.split(/[,;]/)[0]).slice(0, 40)}`;
}

/** Kilometres and ascent in "17 a 25 km", "25 km/600 m prevýšenia". */
function parseMode(text) {
  const ascent = Number(
    /(\d+)\s*m\s*(?:prevýšen|stúpan)|prevýšen\S*\s*(\d+)\s*m/i
      .exec(text)
      ?.slice(1)
      .find(Boolean) ?? Number.NaN,
  );

  // The numbers before each "km", not the metres of an ascent.
  const kms = [...text.matchAll(/([\d,\s.aažresp]+?)\s*km/gi)].flatMap(
    ([, list]) =>
      list
        .split(/,|\ba\b|\baž\b|\bresp\b\.?|–|-/)
        .map((t) => Number.parseFloat(t.replace(/\s/g, '')))
        .filter((n) => Number.isFinite(n) && n > 0 && n < 1000),
  );

  return { kms, ascent: Number.isFinite(ascent) ? ascent : null };
}

const sentencesOf = (text) =>
  text
    .split(/(?<=[.!?;])\s+(?=\p{Lu})/u)
    .map((s) => s.trim())
    .filter(Boolean);

async function eventOf(lines, { year, url, cacheDir }) {
  const notes = [];

  const dates = parseDate(lines[0], year);

  let i = 1;

  const titleLines = [];

  while (i < lines.length && !MODE.test(lines[i]) && !/^Info:/.test(lines[i])) {
    titleLines.push(lines[i++]);
  }

  let mode = null;

  if (MODE.test(lines[i] ?? '')) {
    const [, letters, rest] = MODE.exec(lines[i++]);

    let text = rest;

    // A long kind line wraps until the club's line.
    while (
      i < lines.length &&
      /[,;]$/.test(text) &&
      !/\b(KST|KT|TJ|OKST|ŠKT|OT|Klub|odbor|Región)\b/.test(lines[i])
    ) {
      text += ` ${lines[i++]}`;
    }

    mode = { letters: letters.split(/\s*,\s*/), text };
  }

  const clubLines = [];

  while (i < lines.length && !/^Info:/.test(lines[i])) {
    clubLines.push(lines[i++]);
  }

  // The contact: "Info:" and what continues it, dropped but for a website.
  const webs = [];

  if (/^Info:/.test(lines[i] ?? '')) {
    let prev = lines[i++];

    webs.push(
      ...prev.matchAll(
        /\b(?:https?:\/\/|www\.)[^\s,;]+|\b[\w-]+(?:\.[\w-]+)*\.sk\b(?:\/[^\s,;]*)?/g,
      ),
    );

    while (
      i < lines.length &&
      (/[,;]$/.test(prev) ||
        /^[^\s]*@|^\+?\d[\d\s/]{7,}|^(?:https?:\/\/|www\.)/.test(lines[i]))
    ) {
      prev = lines[i++];

      webs.push(
        ...prev.matchAll(
          /\b(?:https?:\/\/|www\.)[^\s,;]+|(?<!@[\w.-]*)\b[\w-]+(?:\.[\w-]+)*\.sk\b(?:\/[^\s,;]*)?/g,
        ),
      );
    }
  }

  const web =
    webs
      .map(([w]) => w.replace(/[.,;]+$/, ''))
      .find(
        (w) =>
          !w.includes('@') &&
          !/gmail|centrum|zoznam|azet|post\.sk|pobox/.test(w),
      ) ?? null;

  const rawText = lines.slice(i).join(' ').replace(/\s+/g, ' ').trim();

  const sentences = sentencesOf(rawText);

  const kept = sentences.filter((s) => !CONTACT_RE.test(s));

  if (kept.length < sentences.length) {
    notes.push('contacts dropped from the text');
  }

  const titleText = titleLines.join(' ').replace(/\s+/g, ' ').trim();

  // "67. Zimný prechod …" → edition 67; a "(920 m n.m, …)" line stays aside.
  const [, edition, nameAndMore] = /^(?:(\d+)\.\s*)?(.*)$/.exec(titleText);

  const [, name, aside] = /^(.*?)\s*(\([^)]*\))?\s*\.?$/.exec(nameAndMore);

  const club = clubLines.join(' ').replace(/\s+/g, ' ').trim();

  // Start time: the first time in a start sentence.
  const startSentences = kept.filter((s) => START_RE.test(s));

  const [, hh, mm] =
    startSentences
      .map((s) => /\b(\d{1,2})[.:,](\d{2})\s*(?:hod|h\b|-|–|$|\s)/.exec(s))
      .find(Boolean) ?? [];

  const startTime =
    hh && Number(hh) < 24 && Number(mm) < 60
      ? `${hh.padStart(2, '0')}:${mm}`
      : null;

  // The meeting place is prose, inflected: the one part read by the LLM, then
  // matched strictly on the map.
  const answer = await meetingPlace({
    title: titleText,
    text: kept.join(' '),
    organizer: club,
    cacheDir,
  });

  let startPoint = null;

  // Shown on the map at its summit when the yearbook says no meeting place.
  let atSummit = null;

  if (answer) {
    // The club's home, to tell a summit from its namesakes.
    const home = answer.organizerTown
      ? (
          await placeOf(
            { place: null, municipality: answer.organizerTown },
            'SK',
          )
        ).point
      : null;

    const placed = await placeOf(answer, 'SK', home);

    startPoint = placed.point;

    notes.push(placed.note);

    if (!startPoint && answer.summit) {
      const summit = await placeOf(
        { place: answer.summit, municipality: null },
        'SK',
        home,
      );

      startPoint = summit.point;

      if (startPoint) {
        atSummit = answer.summit;

        notes.push(`placed at the summit: ${summit.note}`);
      } else {
        notes.push(`summit: ${summit.note}`);
      }
    }
  } else {
    notes.push('no place: no ANTHROPIC_API_KEY');
  }

  const kinds = mode?.letters.map((l) => KINDS[l]).filter(Boolean) ?? [];

  const { kms, ascent } = mode
    ? parseMode(mode.text)
    : { kms: [], ascent: null };

  const dateOnly = !startTime;

  const startAt = dateOnly
    ? `${dates.start}T00:00:00.000Z`
    : zonedBratislava(dates.start, startTime);

  const endAt = dates.end
    ? dateOnly
      ? `${dates.end}T00:00:00.000Z`
      : zonedBratislava(dates.end, '23:59')
    : null;

  const sourceKey = sourceKeyOf(lines, year);

  const description = [
    aside ?? null,
    edition ? `${edition}. ročník.` : null,
    atSummit
      ? `Miesto stretnutia ročenka neuvádza; na mape je cieľ, ${atSummit}.`
      : null,
    mode
      ? `**Druh turistiky:** ${kinds.map(([label]) => label).join(', ')} – ${mode.text}`
      : null,
    club
      ? `**Organizátor:** ${club}${web ? ` ([${web.replace(/^https?:\/\//, '')}](${/^https?:/.test(web) ? web : `https://${web}`}))` : ''}`
      : null,
    kept.join(' ') || null,
    `**Zdroj:** Ročenka a kalendár KST ${year}, ${url}`,
  ]
    .filter(Boolean)
    .join('\n\n');

  return {
    url,
    sourceKey,
    notes,
    body: startPoint
      ? {
          sourceKey,
          title: name,
          description,
          startAt,
          endAt,
          dateOnly,
          startPoint,
          visibility: 'public',
          transports: [
            ...new Set(kinds.map(([, kind]) => kind).filter(Boolean)),
          ],
          distance: kms.length ? Math.round(Math.max(...kms) * 1000) : null,
          ascent,
        }
      : null,
  };
}

const zonedBratislava = (date, time) =>
  zonedToIso(date, time, 'Europe/Bratislava');

/** The events from `from` to `to`, each `{ url, sourceKey, notes, body, failed? }`. */
async function harvest({ from, to, limit, today, cacheDir }) {
  const results = [];

  /** Each key given out, with its entry's text. */
  const seen = new Map();

  const year = Number(today.slice(0, 4));

  // This year's yearbook, and next year's once it is out.
  for (const y of [year, year + 1]) {
    const url = pdfUrl(y);

    const pdfPath = join(cacheDir, `kst-${y}.pdf`);

    const metaPath = join(cacheDir, `kst-${y}.json`);

    let meta = {};

    try {
      meta = JSON.parse(readFileSync(metaPath, 'utf8'));
    } catch {
      // Not downloaded yet.
    }

    try {
      await assertAllowed(url);

      const file = await politeFetchFile(url, meta.lastModified);

      if (file) {
        mkdirSync(cacheDir, { recursive: true });

        writeFileSync(pdfPath, file.bytes);

        writeFileSync(
          metaPath,
          JSON.stringify({ lastModified: file.lastModified }),
        );
      }
    } catch (err) {
      // Next year's isn't published until about December.
      if (err.status === 404) {
        console.error(`kst.sk: no yearbook for ${y}`);

        continue;
      }

      throw err;
    }

    const events = eventLines(blocksOf(pdfPath));

    console.error(`kst.sk ${y}: ${events.length} events in the yearbook`);

    for (const { lines } of events) {
      const dates = parseDate(lines[0], y);

      if (!dates) {
        continue;
      }

      if ((dates.end ?? dates.start) < from || dates.start > to) {
        continue;
      }

      if (results.length >= limit) {
        break;
      }

      // One printed twice word for word (or in two yearbooks) is one event;
      // two differing under one key are told apart by their order.
      const text = lines.join('\n');

      let key = sourceKeyOf(lines, y);

      if (seen.get(key) === text) {
        continue;
      }

      for (let n = 2; seen.has(key); n++) {
        key = `${sourceKeyOf(lines, y)}-${n}`;
      }

      seen.set(key, text);

      try {
        const result = await eventOf(lines, { year: y, url, cacheDir });

        result.sourceKey = key;

        if (result.body) {
          result.body.sourceKey = key;
        }

        results.push(result);
      } catch (err) {
        console.error(`  ${lines[0]} ${lines[1]}: ${err}`);

        results.push({
          url,
          sourceKey: key,
          failed: true,
          notes: [String(err), ...lines.slice(0, 3)],
          body: null,
        });
      }
    }
  }

  return results;
}

export default {
  key: 'kst',
  /** For `--create-organizer`; its id then goes into `organizerId`. */
  organizer: {
    name: 'Klub slovenských turistov',
    pictureUrl:
      'https://www.kst.sk/wp-content/uploads/2024/11/logoKST1024x1024.png',
  },
  /** The account the events are entered for, on www.freemap.sk. */
  organizerId: 10879,
  harvest,
};
