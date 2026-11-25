// iCalendar (RFC 5545) text of events.

export interface IcalEvent {
  id: string;
  title: string;
  description: string | null;
  startAt: Date;
  endAt: Date | null;
  dateOnly: boolean;
  startLat: number;
  startLon: number;
  updatedAt: Date;
  organizer: string;
  url: string;
}

/** A TEXT value: backslash, semicolon, comma and newline escaped, other controls dropped. */
const text = (s: string) =>
  s
    .replace(/[\\;,]/g, '\\$&')
    .replace(/\r\n?|\n/g, '\\n')
    // biome-ignore lint/suspicious/noControlCharactersInRegex: dropping them
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');

const utc = (d: Date) => d.toISOString().replace(/[-:]|\.\d{3}/g, '');

const day = (d: Date) => d.toISOString().slice(0, 10).replaceAll('-', '');

/** A content line folded at 75 octets, never inside a UTF-8 sequence. */
export function fold(line: string) {
  const out: string[] = [];

  let current = '';

  let octets = 0;

  for (const ch of line) {
    const n = Buffer.byteLength(ch);

    // A continuation line's leading space counts.
    if (octets + n > (out.length ? 74 : 75)) {
      out.push(current);

      current = '';

      octets = 0;
    }

    current += ch;

    octets += n;
  }

  out.push(current);

  return out.join('\r\n ');
}

function vevent(e: IcalEvent, stamp: Date) {
  // A date-only event's bounds are UTC midnights; DTEND is exclusive.
  const times = e.dateOnly
    ? [
        `DTSTART;VALUE=DATE:${day(e.startAt)}`,
        `DTEND;VALUE=DATE:${day(new Date((e.endAt ?? e.startAt).getTime() + 86_400_000))}`,
      ]
    : [
        `DTSTART:${utc(e.startAt)}`,
        // TODO no end gives a zero-length entry; the app assumes 24 h (eventEndSql).
        ...(e.endAt ? [`DTEND:${utc(e.endAt)}`] : []),
      ];

  return [
    'BEGIN:VEVENT',
    `UID:${e.id}@freemap.sk`,
    `DTSTAMP:${utc(stamp)}`,
    `LAST-MODIFIED:${utc(e.updatedAt)}`,
    ...times,
    `SUMMARY:${text(e.title)}`,
    `DESCRIPTION:${text([e.description, e.organizer, e.url].filter(Boolean).join('\n\n'))}`,
    `LOCATION:${e.startLat.toFixed(6)}\\, ${e.startLon.toFixed(6)}`,
    `GEO:${e.startLat.toFixed(6)};${e.startLon.toFixed(6)}`,
    `URL:${e.url}`,
    'END:VEVENT',
  ];
}

/** A calendar named `name`, refreshed by subscribers every 6 hours. */
export function icalendar(name: string, events: IcalEvent[], stamp: Date) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Freemap//Events//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${text(name)}`,
    'REFRESH-INTERVAL;VALUE=DURATION:PT6H',
    'X-PUBLISHED-TTL:PT6H',
    ...events.flatMap((e) => vevent(e, stamp)),
    'END:VCALENDAR',
  ];

  return `${lines.map(fold).join('\r\n')}\r\n`;
}
