// The LLM, only for what a parser can't read reliably: where an event's
// participants meet, and the summit a walk goes to, written in prose and
// inflected. Needs ANTHROPIC_API_KEY; without it the question goes unanswered.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
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
