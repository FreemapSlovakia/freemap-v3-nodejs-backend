// South Tyrol's hikes from its Open Data Hub (NOI), the tourism API its
// tourist offices feed: the events with a hiking word in the title or text,
// CC0 only, one event per date it lists. No key, no LLM.

import {
  addDays,
  assertAllowed,
  daysBetween,
  isDate,
  md,
  politeFetch,
  text,
  zonedToIso,
} from './fetch.mjs';

const API = 'https://tourism.api.opendatahub.com/v1/Event';

const FIELDS = [
  'Id',
  'Detail',
  'EventDate',
  'Latitude',
  'Longitude',
  'LicenseInfo',
  'ContactInfos',
  'OrganizerInfos',
  'LocationInfo',
  '_Meta',
].join(',');

// Tags are inconsistent; a hike says so in its title, as a word: not a
// "Wanderausstellung", a "Wanderbus" or a film named "Spaziergang nach …".
const HIKE_RE =
  /wanderung|wandern\b|wandert\b|spaziergang|schneeschuh|trekking|nordic walking|escursion|camminat|passeggiat|ciaspol|\bhike|hiking/i;

const NOT_HIKE_RE =
  /kino|film|ausstellung|cinema|mostra|konzert|concerto|guest pass|wanderbus|\bbus\b/i;

// A date longer is a season's offer, not an outing.
const MAX_DAYS = 2;

// More often a week is a standing offer, not an outing.
const MAX_PER_WEEK = 3;

// A series' dates this far ahead only, the nightly run adding the later.
const SERIES_DAYS = 42;

// A sentence giving a contact: an email, a phone number, words introducing one.
const CONTACT_RE =
  /[\w.+-]+(@|\(at\))[\w-]+(\.[\w-]+)+|\+39|\b0\d{2,3}[\s/-]?\d{5,7}\b|\btel\.|telefon|e-?mail|mobil|cellulare/i;

function eventsOf(e, { from, to }) {
  if (e.LicenseInfo?.License !== 'CC0' || e.LicenseInfo?.ClosedData) {
    return [];
  }

  const de = e.Detail?.de ?? {};

  const it = e.Detail?.it ?? {};

  const title = (de.Title ?? it.Title ?? '').trim();

  const rawText = text(de.BaseText ?? it.BaseText ?? '');

  const titles = `${title} ${it.Title ?? ''}`;

  if (!HIKE_RE.test(titles) || NOT_HIKE_RE.test(titles)) {
    return [];
  }

  const notes = [];

  const lat = Number(e.Latitude);

  const lon = Number(e.Longitude);

  // South Tyrol and a margin around it.
  const located = lat >= 46 && lat <= 47.2 && lon >= 10.2 && lon <= 12.6;

  if (!located) {
    notes.push('no place in South Tyrol');
  }

  const body = rawText
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => !CONTACT_RE.test(sentence))
    .join(' ');

  if (body !== rawText) {
    notes.push('contacts dropped from the text');
  }

  const organizer =
    e.OrganizerInfos?.de?.CompanyName ?? e.ContactInfos?.de?.CompanyName;

  const web = e.OrganizerInfos?.de?.Url ?? e.ContactInfos?.de?.Url;

  const municipality =
    e.LocationInfo?.MunicipalityInfo?.Name?.de ??
    e.LocationInfo?.TvInfo?.Name?.de;

  const description = [
    body ? md(body) : null,
    it.Title && it.Title.trim() !== title
      ? `**Italiano:** ${md(it.Title.trim())}`
      : null,
    municipality ? `**Ort:** ${md(municipality)}` : null,
    organizer || web
      ? `**Veranstalter:** ${md(organizer ?? web.replace(/^https?:\/\//, '').replace(/\/$/, ''))}${organizer && web ? ` ([${md(web.replace(/^https?:\/\//, '').replace(/\/$/, ''))}](${web}))` : ''}`
      : null,
    `**Quelle:** Open Data Hub Südtirol (CC0), ${API}/${e.Id}`,
  ]
    .filter(Boolean)
    .join('\n\n');

  const dates = (e.EventDate ?? [])
    .filter((d) => d.Cancelled !== '1' && !d.IsCancelled)
    .map((d) => ({
      ...d,
      fromDay: d.From.slice(0, 10),
      toDay: (d.To ?? d.From).slice(0, 10),
    }))
    .filter(
      (d) =>
        isDate(d.fromDay) &&
        isDate(d.toDay) &&
        daysBetween(d.fromDay, d.toDay) <= MAX_DAYS &&
        d.toDay >= from &&
        d.fromDay <= to,
    )
    .toSorted((a, b) => a.fromDay.localeCompare(b.fromDay));

  if (dates.length > 1) {
    const weeks =
      Math.max(daysBetween(dates[0].fromDay, dates.at(-1).fromDay), 7) / 7;

    if (dates.length / weeks > MAX_PER_WEEK) {
      return [];
    }
  }

  const horizon = addDays(from, SERIES_DAYS);

  return dates
    .filter((d, i) => i === 0 || d.fromDay <= horizon)
    .map((d) => {
      const sourceKey = `suedtirol:${e.Id}:${d.fromDay}`;

      const begin = d.Begin?.slice(0, 5);

      const end = d.End?.slice(0, 5);

      // "00:00" is the source's unset time.
      const timed = begin && begin !== '00:00';

      const startAt = timed
        ? zonedToIso(d.fromDay, begin, 'Europe/Rome')
        : `${d.fromDay}T00:00:00.000Z`;

      let endAt = timed
        ? end && end !== '00:00'
          ? zonedToIso(d.toDay, end, 'Europe/Rome')
          : null
        : d.toDay !== d.fromDay
          ? `${d.toDay}T00:00:00.000Z`
          : null;

      if (endAt && Date.parse(endAt) <= Date.parse(startAt)) {
        endAt = null;
      }

      return {
        url: `${API}/${e.Id}`,
        sourceKey,
        notes,
        body: located
          ? {
              sourceKey,
              title,
              description,
              startAt,
              endAt,
              dateOnly: !timed,
              startPoint: { lat, lon },
              transports: ['hiking'],
            }
          : null,
      };
    });
}

/** The events from `from` to `to`, each `{ url, sourceKey, notes, body }`. */
async function harvest({ from, to, limit }) {
  const results = [];

  for (let page = 1, pages = 1; page <= pages; page++) {
    const url = `${API}?${new URLSearchParams({
      begindate: from,
      ...(to < '9999' ? { enddate: to } : {}),
      pagesize: '500',
      pagenumber: String(page),
      fields: FIELDS,
    })}`;

    await assertAllowed(url);

    const { Items, TotalPages, TotalResults } = JSON.parse(
      await politeFetch(url),
    );

    if (page === 1) {
      console.error(`opendatahub: ${TotalResults} events listed`);
    }

    pages = TotalPages;

    results.push(...Items.flatMap((e) => eventsOf(e, { from, to })));
  }

  return results
    .toSorted((a, b) =>
      a.sourceKey.slice(-10).localeCompare(b.sourceKey.slice(-10)),
    )
    .slice(0, limit);
}

export default {
  key: 'suedtirol',
  /** For `--create-organizer`; its id then goes into `organizerId`. */
  organizer: {
    name: 'Open Data Hub Südtirol',
    pictureUrl: 'https://opendatahub.com/icon/footer/open-data-hub.svg',
  },
  /** The account the events are entered for, on www.freemap.sk. */
  organizerId: 10889,
  harvest,
};
