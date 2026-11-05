import got from 'got';
import type { ParameterizedContext } from 'koa';
import { getEnv, getEnvBoolean } from './env.js';

/**
 * The language to write in: `preferred` (the user's) if `available` has it,
 * else the browser's best among them, else English.
 */
export function pickLanguage(
  ctx: ParameterizedContext,
  preferred: string | null | undefined,
  available: Record<string, unknown>,
): string {
  return preferred && Object.hasOwn(available, preferred)
    ? preferred
    : ctx.acceptsLanguages(Object.keys(available)) || 'en';
}

export async function sendMail(
  to: string,
  subject: string,
  text: string,
  /**
   * Give up after this long. Callers that are holding something up until the
   * mail settles want it — a black-holed connection to Mailgun otherwise never
   * resolves. Left unset (as the request handlers do) the send waits forever,
   * which is the pre-existing behaviour and not something to change from here.
   */
  timeoutMs?: number,
) {
  await got.post(
    `https://api${getEnvBoolean('MAILGUN_EU', false) ? '.eu' : ''}.mailgun.net/v3/${getEnv('MAILGUN_DOMAIN')}/messages`,
    {
      username: 'api',
      password: getEnv('MAILGUN_API_KEY'),
      form: {
        from: 'Freemap <noreply@freemap.sk>',
        to,
        subject,
        text,
      },
      ...(timeoutMs === undefined
        ? {}
        : { timeout: { request: timeoutMs } as const }),
    },
  );
}
