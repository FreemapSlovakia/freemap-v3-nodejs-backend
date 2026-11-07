// France's hikes from DATAtourisme, the national open tourism dataset its
// tourist offices feed (Licence Ouverte: reuse crediting it, the producer and
// the date of its update). Its API, the "Rambling" events, one event per day
// it is held. A free key, DATATOURISME_API_KEY. No LLM.

import { assertAllowed, politeFetch, zonedToIso } from './fetch.mjs';

const API = 'https://api.datatourisme.fr/v1/entertainmentAndEvent';

const KEY = process.env.DATATOURISME_API_KEY;

const FIELDS = [
  'uuid',
  'uri',
  'label',
  'type',
  'isLocatedAt.geo',
  'isLocatedAt.address',
  'hasBeenCreatedBy',
  'lastUpdate',
  'hasContact',
  'isOwnedBy',
  'hasDescription',
  'takesPlaceAt',
  'hasTheme',
].join(',');

// Producers file a loto or a tapas night as Rambling too: a hike says so.
const HIKE_RE =
  /randonn|rando\b|marche|balade|ballade|promenade|sortie nature|p[ée]destre|VTT|trail|circuit|sentier|boucle|nordique|excursion|d[ée]couverte nature|itin[ée]raire|chemin/i;

// A period longer is a season's offer, not an outing.
const MAX_DAYS = 2;

// A sentence giving a contact: an email, a phone number, words introducing one.
const CONTACT_RE =
  /[\w.+-]+(@|\(at\))[\w-]+(\.[\w-]+)+|\+33|\b0\d([\s.-]?\d{2}){4}\b|t[ée]l[ée]phone|\bt[ée]l\b|portable|e-?mail/i;

// A contact naming an organization, not a person.
const ORGANIZATION_RE =
  /club|association|asso\b|office|comit[ée]|amicale|mairie|commune|f[ée]d[ée]ration|ffr|groupe|section|syndicat|parc|foyer|cercle|union|soci[ée]t[ée]|centre|maison/i;

const fr = (value) => value?.['@fr'] ?? Object.values(value ?? {})[0] ?? '';

const days = (from, to) => (Date.parse(to) - Date.parse(from)) / 86_400_000;

const dateFr = (d) => d.split('-').reverse().map(Number).join('/');

function eventsOf(poi, { from, to }) {
  // A place or a product sold all year is no outing.
  if (
    poi.type.includes('Product') ||
    poi.type.includes('PlaceOfInterest') ||
    !poi.takesPlaceAt?.length
  ) {
    return [];
  }

  const periods = poi.takesPlaceAt.map((p) => ({
    ...p,
    endDate: p.endDate ?? p.startDate,
  }));

  if (periods.some((p) => days(p.startDate, p.endDate) > MAX_DAYS)) {
    return [];
  }

  const notes = [];

  const geo = poi.isLocatedAt?.[0]?.geo;

  const lat = Number(geo?.latitude);

  const lon = Number(geo?.longitude);

  const located = lat >= 41 && lat <= 52 && lon >= -6 && lon <= 10;

  if (!located) {
    notes.push('no place in metropolitan France');
  }

  const rawText = fr(
    poi.hasDescription?.[0]?.description ??
      poi.hasDescription?.[0]?.shortDescription,
  ).trim();

  const text = rawText
    .split(/(?<=[.!?])\s+|\n+/)
    .filter((sentence) => !CONTACT_RE.test(sentence))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (text !== rawText.replace(/\s+/g, ' ')) {
    notes.push('contacts dropped from the text');
  }

  // One length only: several are the choice of routes, said in the text.
  const kms = [
    ...new Set(
      [...rawText.matchAll(/(\d+(?:[,.]\d+)?)\s*km\b/gi)].map(([, n]) =>
        Number(n.replace(',', '.')),
      ),
    ),
  ];

  const ascent = Number(
    /(\d+)\s*m(?:[eè]tres)?\s*(?:de\s*)?d[ée]nivel/i.exec(rawText)?.[1] ??
      Number.NaN,
  );

  // Whoever runs it, if an organization, with its website.
  const organizer = [...(poi.isOwnedBy ?? []), ...(poi.hasContact ?? [])].find(
    (c) => c.legalName && ORGANIZATION_RE.test(c.legalName),
  );

  const web = organizer?.homepage?.[0];

  const address = poi.isLocatedAt?.[0]?.address?.[0];

  const place = [address?.streetAddress?.join(', '), address?.addressLocality]
    .filter(Boolean)
    .join(', ');

  const producer = poi.hasBeenCreatedBy?.legalName;

  const description = [
    text || null,
    place ? `**Lieu :** ${place}` : null,
    organizer
      ? `**Organisateur :** ${organizer.legalName}${web ? ` ([${web.replace(/^https?:\/\//, '').replace(/\/$/, '')}](${web}))` : ''}`
      : null,
    `**Source :** DATAtourisme${producer ? `, ${producer}` : ''}${poi.lastUpdate ? `, mise à jour le ${dateFr(poi.lastUpdate)}` : ''}, ${poi.uri}`,
  ]
    .filter(Boolean)
    .join('\n\n');

  const themes = (poi.hasTheme ?? []).map((t) => t.key);

  const label = fr(poi.label).trim();

  if (!HIKE_RE.test(label) && !HIKE_RE.test(rawText)) {
    return [];
  }

  const mtb =
    themes.some((t) => /MountainBike/i.test(t)) || /\bVTT\b/i.test(label);

  return periods
    .filter((p) => p.endDate >= from && p.startDate <= to)
    .map((p) => {
      const sourceKey = `datatourisme:${poi.uuid}:${p.startDate}`;

      const clock = p.startTime?.slice(0, 5);

      const dateOnly = !clock;

      const endClock = p.endTime?.slice(0, 5);

      const startAt = dateOnly
        ? `${p.startDate}T00:00:00.000Z`
        : zonedToIso(p.startDate, clock, 'Europe/Paris');

      let endAt = dateOnly
        ? p.endDate !== p.startDate
          ? `${p.endDate}T00:00:00.000Z`
          : null
        : endClock
          ? zonedToIso(p.endDate, endClock, 'Europe/Paris')
          : null;

      // An end at or before the start the same day is past midnight, as a
      // night trail's "00:00"; any other is a slip, and dropped.
      if (endAt && !dateOnly && Date.parse(endAt) <= Date.parse(startAt)) {
        endAt =
          p.endDate === p.startDate
            ? new Date(Date.parse(endAt) + 86_400_000).toISOString()
            : null;
      }

      return {
        url: poi.uri,
        sourceKey,
        notes,
        body: located
          ? {
              sourceKey,
              title: label,
              description,
              startAt,
              endAt,
              dateOnly,
              startPoint: { lat, lon },
              visibility: 'public',
              transports: mtb ? ['mtb'] : ['hiking'],
              distance: kms.length === 1 ? Math.round(kms[0] * 1000) : null,
              ascent: Number.isFinite(ascent) ? ascent : null,
            }
          : null,
      };
    });
}

/** The events from `from` to `to`, each `{ url, sourceKey, notes, body }`. */
async function harvest({ from, to, limit }) {
  if (!KEY) {
    throw new Error('DATATOURISME_API_KEY is not set');
  }

  const query = new URLSearchParams({
    filters: `type[eq]=Rambling AND takesPlaceAt.endDate[gte]=${from}`,
    fields: FIELDS,
    lang: 'fr',
    page_size: '100',
  });

  const results = [];

  // The next page's link, as the API recommends: page numbers stop at 10000.
  for (let url = `${API}?${query}`, page = 1; url; page++) {
    await assertAllowed(url);

    const { objects, meta } = JSON.parse(
      await politeFetch(url, { 'X-API-Key': KEY }),
    );

    if (page === 1) {
      console.error(`datatourisme: ${meta.total} hikes listed`);
    }

    results.push(...objects.flatMap((poi) => eventsOf(poi, { from, to })));

    url = results.length < (limit ?? Infinity) ? meta.next : null;
  }

  return results
    .toSorted((a, b) =>
      a.sourceKey.slice(-10).localeCompare(b.sourceKey.slice(-10)),
    )
    .slice(0, limit);
}

export default {
  key: 'datatourisme',
  /** For `--create-organizer`; its id then goes into `organizerId`. */
  organizer: {
    name: 'DATAtourisme',
    pictureUrl:
      'https://www.datatourisme.fr/wp-content/uploads/2016/07/cropped-favicon-270x270.png',
  },
  /** The account the events are entered for, on www.freemap.sk. */
  organizerId: 10887,
  harvest,
};
