import got from 'got';
import { getEnv } from './env.js';

export async function sendMail(to: string, subject: string, text: string) {
  await got.post(
    `https://api.mailgun.net/v3/${getEnv('MAILGIN_DOMAIN')}/messages`,
    {
      username: 'api',
      password: getEnv('MAILGIN_API_KEY'),
      form: {
        from: 'Freemap <noreply@freemap.sk>',
        to,
        subject,
        text,
      },
    },
  );
}
