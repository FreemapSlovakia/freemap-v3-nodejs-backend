import { htmlLink, htmlPara, htmlQuote, htmlRef } from '../../mailHtml.js';
import type { Recipient } from '../../mailWatch.js';
import {
  type MailLang,
  mailLang,
  sendWatchedMail,
  userUrl,
} from '../../notificationMail.js';

/** Who commented, the photo's title (with a trailing space, or none) and its address. */
type Parts = { name: string; title: string; url: string };

// Exported for the test that no wording holds a markup character.
export const MESSAGES: Record<MailLang, (p: Parts, own: boolean) => string> = {
  sk: ({ name, title, url }, own) =>
    `Používateľ ${name} pridal komentár k ${own ? 'vašej ' : ''}fotke ${title}na ${url}:`,
  cs: ({ name, title, url }, own) =>
    `Uživatel ${name} přidal komentář k ${own ? 'vaší ' : ''}fotce ${title}na ${url}:`,
  en: ({ name, title, url }, own) =>
    `User ${name} commented ${own ? 'your' : 'a'} photo ${title}at ${url}:`,
  hu: ({ name, title, url }, own) =>
    `A felhasználó ${name} hozzászólt ${own ? 'az Ön' : 'egy'} fotójához: ${title}${url}:`,
  it: ({ name, title, url }, own) =>
    `L'utente ${name} ha commentato ${own ? 'la Sua' : 'una'} foto ${title}su ${url}:`,
  de: ({ name, title, url }, own) =>
    `Benutzer ${name} hat ${own ? 'Ihr' : 'ein'} Foto kommentiert: ${title}${url}:`,
  pl: ({ name, title, url }) =>
    `Użytkownik ${name} dodał komentarz do zdjęcia ${title}na ${url}:`,
  sl: ({ name, title, url }, own) =>
    `Uporabnik ${name} je dodal komentar k ${own ? 'vaši ' : ''}fotografiji ${title}na ${url}:`,
  fr: ({ name, title, url }, own) =>
    `L'utilisateur ${name} a commenté ${own ? 'votre' : 'une'} photo ${title}sur ${url} :`,
};

/**
 * Sends a photo-comment notification email in the recipient's language.
 * Shared by gallery and Wikimedia comments; `own` marks the photo's own
 * uploader (never set for Wikimedia photos).
 */
export async function sendCommentMail(opts: {
  recipient: Recipient;
  target: 'picture' | 'wikimedia';
  targetId: number;
  own: boolean;
  commenter: { id: number; name: string };
  comment: string;
  picUrl: string;
  picTitle: string | null;
  /** The site the comment was posted on. */
  web: string;
}): Promise<void> {
  const { recipient, own, commenter, comment, picUrl, picTitle, web } = opts;

  const webUrl = web.replace(/^https?:\/\//, '');

  const subjects: Record<MailLang, string> = {
    sk: `Komentár k fotke na ${webUrl}`,
    cs: `Komentář k fotce na ${webUrl}`,
    en: `Photo comment at ${webUrl}`,
    hu: `Hozzászólás a fotóhoz a következőn: ${webUrl}`,
    it: `Commento alla foto su ${webUrl}`,
    de: `Kommentar zu einem Foto auf ${webUrl}`,
    pl: `Komentarz do zdjęcia na ${webUrl}`,
    sl: `Komentar k fotografiji na ${webUrl}`,
    fr: `Commentaire sur une photo sur ${webUrl}`,
  };

  const lang = mailLang(recipient.language);

  const message = MESSAGES[lang];

  await sendWatchedMail({
    recipient,
    target: opts.target,
    targetId: opts.targetId,
    subject: subjects[lang],
    body: `${message(
      {
        name: commenter.name,
        title: picTitle ? `"${picTitle}" ` : '',
        url: picUrl,
      },
      own,
    )}\n\n${comment}`,
    html: [
      htmlPara(
        message(
          {
            name: htmlRef(commenter.name, userUrl(commenter.id, web)),
            title: picTitle ? `${htmlRef(picTitle, picUrl)} ` : '',
            url: htmlLink(picUrl),
          },
          own,
        ),
      ),
      htmlQuote(comment),
    ],
    web,
  });
}
