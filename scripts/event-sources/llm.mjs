// The LLM, only for what a parser can't read reliably: where an event's
// participants meet, and the summit a walk goes to, written in prose and
// inflected; and whole calendars whose layout differs by publisher. Needs
// ANTHROPIC_API_KEY; without it the question goes unanswered.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import z from 'zod';

const MODEL = 'claude-haiku-5-5';

const PlaceSchema = z.object({
  /** The meeting point as a map names it, in the nominative; null if unsaid. */
  place: z.string().nullable(),
  /** The municipality it is in, in the nominative; null if unsaid. */
  municipality: z.string().nullable(),
  /** The summit a summit walk goes to, in the nominative; null for others. */
  summit: z.string().nullable(),
  /** The organizing club's home municipality, to tell namesakes apart. */
  organizerTown: z.string().nullable(),
});

// Bumped when the schema or the prompt changes, so cached answers are asked again.
const VERSION = 3;

const client = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;

let cache;

let cachePath;

export const llmAvailable = () => client !== null;

/**
 * Where an event's participants meet, from its title and text, as
 * `{ place, municipality, summit, organizerTown }` (any may be null), or null
 * without a key.
 * Answers are cached by their input, so a rerun doesn't ask again.
 */
export async function meetingPlace({ title, text, organizer, cacheDir }) {
  if (!client) {
    return null;
  }

  if (!cache) {
    cachePath = join(cacheDir, 'llm-places.json');

    try {
      cache = JSON.parse(readFileSync(cachePath, 'utf8'));
    } catch {
      cache = {};
    }
  }

  const input = `Názov: ${title}\nOrganizátor: ${organizer}\nText: ${text}`;

  const key = createHash('sha256')
    .update(`${MODEL}\n${VERSION}\n${input}`)
    .digest('hex');

  if (key in cache) {
    return cache[key];
  }

  const response = await client.messages.parse({
    model: MODEL,
    max_tokens: 4000,
    output_config: { effort: 'low', format: zodOutputFormat(PlaceSchema) },
    system:
      'You read Slovak and Czech hiking event announcements. Give where the participants meet at the start, as a map would name it: the place (a station, square, chalet, summit, car park) and the municipality, both in the nominative case, without prepositions. "Odchod z námestia v Mýtnej" is place "námestie", municipality "Mýtna"; "Stretnutie na vrchole" of "Výstup na Babiu horu" is place "Babia hora". Use only what the text says; where it says neither, give null. Separately, for a walk to a summit, give that summit in the nominative ("Výstup na Babiu horu" is summit "Babia hora"); for any other event, null. Also give the organizing club\'s home municipality in the nominative, where its name or the text says it ("Námestovský KST" is "Námestovo"; "KST Turie, obec Turie" is "Turie"); otherwise null.',
    messages: [{ role: 'user', content: input }],
  });

  const answer = response.parsed_output ?? null;

  cache[key] = answer;

  mkdirSync(cacheDir, { recursive: true });

  writeFileSync(cachePath, JSON.stringify(cache));

  return answer;
}

// A whole calendar is read at once, layouts differing by publisher.
const CALENDAR_MODEL = 'claude-opus-5-5';

const CALENDAR_VERSION = 1;

const CalendarEventSchema = z.object({
  /** YYYY-MM-DD. */
  date: z.string(),
  /** YYYY-MM-DD of a multi-day event's last day; null for one day. */
  endDate: z.string().nullable(),
  /** HH:MM when participants start or meet; null if unsaid. */
  time: z.string().nullable(),
  /** The name only: no edition, no date, as written but not in capitals. */
  title: z.string(),
  edition: z.number().nullable(),
  /** The organizing club, as written. */
  organizer: z.string().nullable(),
  kinds: z.array(z.enum(['hiking', 'bike', 'ski', 'water', 'other'])),
  /** Each route's length in km. */
  lengthsKm: z.array(z.number()),
  /** Ascent in metres, of the longest route; null if unsaid. */
  ascent: z.number().nullable(),
  /** Route, start and finish, fee and notes, without any person's name, phone or email. */
  details: z.string().nullable(),
  /** The organizer's website, if given; never a social network's. */
  web: z.string().nullable(),
  ...PlaceSchema.shape,
});

const CalendarSchema = z.object({ events: z.array(CalendarEventSchema) });

let calendarCache;

let calendarCachePath;

/**
 * The events of a club calendar's text (pdftotext output), each as
 * {@link CalendarEventSchema}, or null without a key. Cached by the text, so
 * a calendar is read again only when it changes.
 */
export async function calendarEvents({ text, year, publisher, cacheDir }) {
  if (!client) {
    return null;
  }

  if (!calendarCache) {
    calendarCachePath = join(cacheDir, 'llm-calendars.json');

    try {
      calendarCache = JSON.parse(readFileSync(calendarCachePath, 'utf8'));
    } catch {
      calendarCache = {};
    }
  }

  const input = `Kalendár: ${publisher}, rok ${year}\n\n${text}`;

  const key = createHash('sha256')
    .update(`${CALENDAR_MODEL}\n${CALENDAR_VERSION}\n${input}`)
    .digest('hex');

  if (key in calendarCache) {
    return calendarCache[key];
  }

  // Streamed: a calendar's events run to many output tokens.
  const message = await client.beta.messages
    .stream({
      model: CALENDAR_MODEL,
      max_tokens: 64000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: {
        effort: 'medium',
        format: betaZodOutputFormat(CalendarSchema),
      },
      system: [
        'You read the text of a Slovak or Czech hiking club calendar, extracted from a PDF, and list every public event in it, each once.',
        'Dates are in the calendar\'s year unless written otherwise; a multi-day event gives its first day as date and its last as endDate. The time is when participants start or meet ("Štart: … o 8.30 hod" is 08:30); for a start window ("6.00 h – 12.00 h") its beginning; null if unsaid.',
        'Give the title in the case it would be written normally, not in capitals, without the edition, which goes to edition ("47. ročník" is 47).',
        'kinds: hiking for walks and marches (P, pešo, vysokohorská), bike for cycling (C, cyklo), ski, water, other for the rest; an event may have several.',
        "details: the route, start, finish, fee and practical notes in a sentence or few, in the calendar's language; leave out every person's name, phone number and email.",
        'For the start, give the meeting place and its municipality as a map names them, in the nominative, without prepositions ("Štart: Dolný Lopašov, turistický klub" is place "turistický klub", municipality "Dolný Lopašov"); for a walk to a summit with no meeting place, that summit as summit; the organizing club\'s home municipality as organizerTown where its name or the text says it. Use only what the text says; otherwise null.',
        'Skip pages of general information, calendar grids, adverts and lists of summits or badges that are not events.',
      ].join('\n'),
      messages: [{ role: 'user', content: input }],
    })
    .finalMessage();

  if (
    message.stop_reason === 'refusal' ||
    message.stop_reason === 'max_tokens'
  ) {
    throw new Error(`calendar of ${publisher} ${year}: ${message.stop_reason}`);
  }

  const json = message.content.find((b) => b.type === 'text')?.text;

  const answer = CalendarSchema.parse(JSON.parse(json ?? '')).events;

  // A fallback model's reading is used once, not kept as this model's.
  if (!message.content.some((b) => b.type === 'fallback')) {
    calendarCache[key] = answer;

    mkdirSync(cacheDir, { recursive: true });

    writeFileSync(calendarCachePath, JSON.stringify(calendarCache));
  }

  return answer;
}
