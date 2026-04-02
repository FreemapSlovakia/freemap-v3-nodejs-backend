import got from 'got';
import { getEnv, getEnvBoolean } from './env.js';

export async function sendMail(to: string, subject: string, text: string) {
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
    },
  );
}
