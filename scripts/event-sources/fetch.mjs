// What every event source fetches and parses with: politely, as robots.txt
// allows, and Photon for places without coordinates.

export const USER_AGENT =
  'FreemapEventsHarvester/0.1 (+https://www.freemap.sk)';

const PHOTON_URL = process.env.PHOTON_URL ?? 'https://photon.freemap.sk';

// Between two requests to the same host.
const DELAY_MS = 2000;

const lastRequest = new Map();

const robotsRules = new Map();

const crawlDelays = new Map();

async function politeResponse(url, headers = {}) {
  const { host } = new URL(url);

  // A robots.txt Crawl-delay, when longer, wins; our own Photon needs less.
  const delay =
    host === new URL(PHOTON_URL).host
      ? 200
      : Math.max(DELAY_MS, crawlDelays.get(host) ?? 0);

  const wait = (lastRequest.get(host) ?? 0) + delay - Date.now();

  if (wait > 0) {
    await new Promise((resolve) => setTimeout(resolve, wait));
  }

  lastRequest.set(host, Date.now());

  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, ...headers },
  });

  if (!res.ok && res.status !== 304) {
    throw Object.assign(new Error(`${url}: HTTP ${res.status}`), {
      status: res.status,
    });
  }

  return res;
}

export async function politeFetch(url) {
  return (await politeResponse(url)).text();
}

/**
 * A file's bytes and its Last-Modified, or null when it is unchanged since
 * `lastModified`, so a big file is downloaded once per change.
 */
export async function politeFetchFile(url, lastModified) {
  const res = await politeResponse(
    url,
    lastModified ? { 'If-Modified-Since': lastModified } : {},
  );

  return res.status === 304
    ? null
    : {
        bytes: Buffer.from(await res.arrayBuffer()),
        lastModified: res.headers.get('Last-Modified'),
      };
}

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
export async function assertAllowed(url) {
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

export const decodeEntities = (s) =>
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

export const text = (html) =>
  decodeEntities(html.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();

/** A wall-clock time in `timeZone` as an instant. */
export function zonedToIso(date, time, timeZone) {
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

export const distanceKm = (a, b) => {
  const rad = Math.PI / 180;

  const x =
    Math.sin(((b.lat - a.lat) * rad) / 2) ** 2 +
    Math.cos(a.lat * rad) *
      Math.cos(b.lat * rad) *
      Math.sin(((b.lon - a.lon) * rad) / 2) ** 2;

  return 12742 * Math.asin(Math.sqrt(x));
};

/** Photon's hits for `query` in `countrycode`, as `{ name, type, point }`. */
export async function geocodeAll(query, countrycode) {
  const url = new URL('/api', PHOTON_URL);

  url.searchParams.set('q', query);
  url.searchParams.set('limit', '10');

  const { features } = JSON.parse(await politeFetch(url.href));

  return features
    .filter((f) => f.properties.countrycode === countrycode)
    .map((f) => ({
      name: f.properties.name ?? '',
      type: f.properties.osm_key === 'place' ? f.properties.osm_value : null,
      peak:
        f.properties.osm_key === 'natural' &&
        ['peak', 'hill', 'volcano'].includes(f.properties.osm_value),
      point: { lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0] },
    }));
}

/** Lower case, no diacritics: "Ľubovňa" and "Lubovna" compare equal. */
export const plain = (s) =>
  s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

const LOCALITY_TYPES = new Set([
  'city',
  'town',
  'village',
  'hamlet',
  'suburb',
  'borough',
  'quarter',
  'neighbourhood',
  'municipality',
  'locality',
]);

// Words naming a kind of place, not which one: "námestie", "parkovisko".
const GENERIC_WORDS = new Set(
  'namestie namesti parkovisko parkoviste stanica stanice zastavka zastavka kd dk kulturny kulturni dom obecny obecni urad chata vrchol autobusova zeleznicna zelezniska nadrazi nadrazie pri pred hlavna hlavni'.split(
    ' ',
  ),
);

const wordsOf = (s) =>
  plain(s)
    .split(/[^\p{L}\d]+/u)
    .filter((w) => w.length >= 3);

/**
 * A place as `{ place, municipality }` (nominative, either may be null) on the
 * map, strictly: the municipality must be found as one, by its name; the place
 * by a word of its own name, within 10 km of it, or without a municipality a
 * summit by its whole name. Else at the municipality, or
 * nothing. `{ point, note }`.
 */
export async function placeOf({ place, municipality }, countrycode) {
  const town = municipality
    ? (await geocodeAll(municipality, countrycode)).find(
        (h) =>
          LOCALITY_TYPES.has(h.type) && plain(h.name) === plain(municipality),
      )
    : undefined;

  const own = place ? wordsOf(place).filter((w) => !GENERIC_WORDS.has(w)) : [];

  if (own.length) {
    const hit = (
      await geocodeAll(town ? `${place}, ${town.name}` : place, countrycode)
    ).find((h) =>
      town
        ? distanceKm(h.point, town.point) <= 10 &&
          wordsOf(h.name).some((w) => own.includes(w))
        : // Nothing to tell a namesake apart: only a summit, by its whole name.
          h.peak && plain(h.name) === plain(place),
    );

    if (hit) {
      return {
        point: hit.point,
        note: `at "${hit.name}"${town ? `, ${town.name}` : ''}`,
      };
    }
  }

  if (town) {
    return {
      point: town.point,
      note: `at the municipality "${town.name}"${place ? `, "${place}" not found` : ''}`,
    };
  }

  return {
    point: null,
    note: `no place found for ${JSON.stringify({ place, municipality })}`,
  };
}

/**
 * The best Photon hit for `query` in `countrycode`, or null; only in `county`
 * if given, and only within `near.km` of `near.point` if given.
 */
export async function geocode(query, countrycode, county, near) {
  const url = new URL('/api', PHOTON_URL);

  url.searchParams.set('q', query);
  url.searchParams.set('limit', '5');

  const { features } = JSON.parse(await politeFetch(url.href));

  const hit = features.find(
    (f) =>
      f.properties.countrycode === countrycode &&
      (!county || f.properties.county?.includes(county)) &&
      (!near ||
        distanceKm(near.point, {
          lat: f.geometry.coordinates[1],
          lon: f.geometry.coordinates[0],
        }) <= near.km),
  );

  return hit
    ? { lat: hit.geometry.coordinates[1], lon: hit.geometry.coordinates[0] }
    : null;
}
