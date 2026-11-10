// Germany's walking days and guided hikes from the DVV (Deutscher
// Volkssportverband), its list of the next three months: one page of marked-up
// entries. Placed by the start address on Photon, else the town. No LLM.

import {
  addDays,
  assertAllowed,
  decodeEntities,
  geocode,
  isDate,
  md,
  placeOf,
  politeFetch,
  text,
  zonedToIso,
} from './fetch.mjs';

const BASE = 'https://www.dvv-wandern.de/';

const LIST_URL = `${BASE}aktuelles-angebot`;

const slugOf = (s) =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

/** One field of an entry, as text; `<span class="date">…</span>`. */
const field = (entry, cls) => {
  const html = new RegExp(
    `<(?:span|strong|div) class="${cls}">([\\s\\S]*?)</(?:span|strong|div)>`,
  ).exec(entry)?.[1];

  return html === undefined ? null : text(html) || null;
};

/**
 * The days of "15.11." or "14./15.11." as YYYY-MM-DD: this year's, or next
 * year's once this year's would be months past.
 */
function daysOf(date, today) {
  const m = /^(\d{1,2})\.(?:\/(\d{1,2})\.)?(\d{1,2})\.$/.exec(date);

  if (!m) {
    return [];
  }

  const [, d1, d2, month] = m;

  const year = Number(today.slice(0, 4));

  const iso = (y, d) =>
    `${y}-${month.padStart(2, '0')}-${String(d).padStart(2, '0')}`;

  // The list runs three months ahead: a date two months back is next year's.
  const y = iso(year, d1) < addDays(today, -60) ? year + 1 : year;

  const days = [d1, d2].filter(Boolean).map((d) => iso(y, d));

  // "31.4." names no day.
  return days.every(isDate) ? days : [];
}

async function eventOf(entry, today, from, to) {
  const notes = [];

  const date = field(entry, 'date') ?? '';

  const name = (field(entry, 'name') ?? '').replace(/^"|"$/g, '').trim();

  const type = field(entry, 'type');

  const kmText = field(entry, 'km');

  const town = field(entry, 'matchcode');

  const club = field(entry, 'club');

  const times = field(entry, 'times');

  const location = field(entry, 'location');

  const train = field(entry, 'trainstation')?.replace(/^Bahnstation:\s*/, '');

  const sights =
    /<div class="pois">\s*<span>[^<]*<\/span>([\s\S]*?)<\/div>/.exec(
      entry,
    )?.[1];

  const pdf = /href="([^"]+\.pdf)"/.exec(entry)?.[1];

  const pdfUrl = pdf ? new URL(decodeEntities(pdf), BASE).href : null;

  const days = daysOf(date, today);

  if (!days.length) {
    notes.push(`date "${date}" not read`);
  }

  // The earliest start of the windows given, as "08:00 - 14:00 Uhr (5 km)".
  const clocks = [...(times ?? '').matchAll(/\b(\d{1,2}):(\d{2})\b/g)].map(
    ([, h, m]) => `${h.padStart(2, '0')}:${m}`,
  );

  const clock = clocks.toSorted()[0] ?? null;

  const kms = [...(kmText ?? '').matchAll(/\d+(?:[,.]\d+)?/g)].map((n) =>
    Number(n[0].replace(',', '.')),
  );

  // The map the page no longer shows still holds the start's coordinates.
  const pinned = /maps\/place\/(-?\d+\.\d+),(-?\d+\.\d+)/.exec(entry);

  let startPoint = pinned
    ? { lat: Number(pinned[1]), lon: Number(pinned[2]) }
    : null;

  // "Lichtenfels Oberlangheim", "Bad Dürkheim-Lindemannsruhe": a district of
  // a town Photon knows by its first part.
  let home = null;

  for (const name of [town, town?.split(/[\s-](?=\p{Lu})/u)[0]]) {
    if (name && !home) {
      home = (await placeOf({ place: null, municipality: name }, 'DE')).point;
    }
  }

  if (startPoint) {
    notes.push('placed by the page’s coordinates');
  } else if (location) {
    // Also without the venue's name, and only street and town, as a car park
    // "gegenüber …, Anfahrt über …" before them leaves Photon lost.
    const parts = location.split(/,\s*/);

    const queries = [
      location,
      parts.slice(1).join(', '),
      parts.slice(-2).join(', '),
    ];

    for (const query of [...new Set(queries)].filter(Boolean)) {
      startPoint = await geocode(
        query,
        'DE',
        null,
        home ? { point: home, km: 15 } : null,
      );

      if (startPoint) {
        notes.push(`geocoded "${query}"`);

        break;
      }
    }
  }

  let atTown = false;

  if (!startPoint && home) {
    startPoint = home;

    atTown = true;

    notes.push(`placed at the town "${town}"`);
  } else if (!startPoint) {
    notes.push(`not geocoded "${location ?? town}"`);
  }

  const description = [
    [
      type ? `**Art:** ${md(type)}` : null,
      kmText ? `**Strecken:** ${md(kmText)}` : null,
    ]
      .filter(Boolean)
      .join(' · ') || null,
    times || location
      ? `**Start:** ${md([times?.replace(/^Start:\s*/, ''), location].filter(Boolean).join(', '))}`
      : null,
    atTown
      ? `Der genaue Startort ist auf der Karte nicht verzeichnet; der Punkt liegt in ${md(town)}.`
      : null,
    train ? `**Bahnstation:** ${md(train)}` : null,
    sights ? `**Sehenswert:** ${md(text(sights))}` : null,
    club ? `**Veranstalter:** ${md(club)}` : null,
    pdfUrl ? `**Ausschreibung:** ${pdfUrl}` : null,
    `**Quelle:** Deutscher Volkssportverband, ${LIST_URL}`,
  ]
    .filter(Boolean)
    .join('\n\n');

  return days
    .filter((day) => day >= from && day <= to)
    .map((day) => {
      const sourceKey = `dvv:${day}-${slugOf(town ?? '')}-${slugOf(name).slice(0, 60)}`;

      return {
        url: pdfUrl ?? LIST_URL,
        sourceKey,
        notes,
        body: startPoint
          ? {
              sourceKey,
              title: name || type,
              description,
              startAt: clock
                ? zonedToIso(day, clock, 'Europe/Berlin')
                : `${day}T00:00:00.000Z`,
              endAt: null,
              dateOnly: !clock,
              startPoint,
              transports: ['hiking'],
              distance: kms.length ? Math.round(Math.max(...kms) * 1000) : null,
            }
          : null,
      };
    });
}

/** The events from `from` to `to`, each `{ url, sourceKey, notes, body }`. */
async function harvest({ from, to, limit, today }) {
  await assertAllowed(LIST_URL);

  const html = await politeFetch(LIST_URL);

  // Each entry is an <li class="… event-none|new|changed">.
  const entries = html.split(/<li class="[^"]*\bevent-/).slice(1);

  if (!entries.length) {
    throw new Error('dvv-wandern.de: no entries on the list');
  }

  console.error(`dvv-wandern.de: ${entries.length} listed`);

  const results = [];

  for (const entry of entries) {
    results.push(...(await eventOf(entry.split('</li>')[0], today, from, to)));
  }

  return results
    .toSorted((a, b) => a.sourceKey.localeCompare(b.sourceKey))
    .slice(0, limit);
}

export default {
  key: 'dvv',
  /** For `--create-organizer`; its id then goes into `organizerId`. */
  organizer: {
    name: 'Deutscher Volkssportverband',
    pictureUrl:
      'https://www.dvv-wandern.de/files/themes/standard2013/img/logo.png',
  },
  /** The account the events are entered for, on www.freemap.sk. */
  organizerId: 10888,
  harvest,
};
