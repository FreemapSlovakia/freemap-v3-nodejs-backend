import type { Recipient } from '../../mailWatch.js';
import {
  type MailLang,
  mailLang,
  sendWatchedMail,
} from '../../notificationMail.js';

/**
 * Sends a photo-comment notification email in the recipient's language.
 * Shared by gallery and Wikimedia comments; `picTitle` is a pre-quoted title
 * with a trailing space (e.g. `"Foo" `) or `''` when unknown, and `own` marks
 * the photo's own uploader (never set for Wikimedia photos).
 */
export async function sendCommentMail(opts: {
  recipient: Recipient;
  target: 'picture' | 'wikimedia';
  targetId: number;
  own: boolean;
  commenterName: string;
  comment: string;
  picUrl: string;
  picTitle: string;
  /** The site the comment was posted on. */
  web: string;
}): Promise<void> {
  const { recipient, own, commenterName, comment, picUrl, picTitle, web } =
    opts;

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

  const messages: Record<MailLang, string> = {
    sk: `Používateľ ${commenterName} pridal komentár k ${own ? 'vašej ' : ''}fotke ${picTitle}na ${picUrl}:`,
    cs: `Uživatel ${commenterName} přidal komentář k ${own ? 'vaší ' : ''}fotce ${picTitle}na ${picUrl}:`,
    en: `User ${commenterName} commented ${own ? 'your' : 'a'} photo ${picTitle}at ${picUrl}:`,
    hu: `A felhasználó ${commenterName} hozzászólt ${own ? 'az Ön' : 'egy'} fotójához: ${picTitle}${picUrl}:`,
    it: `L'utente ${commenterName} ha commentato ${own ? 'la Sua' : 'una'} foto ${picTitle}su ${picUrl}:`,
    de: `Benutzer ${commenterName} hat ${own ? 'Ihr' : 'ein'} Foto kommentiert: ${picTitle}${picUrl}:`,
    pl: `Użytkownik ${commenterName} dodał komentarz do zdjęcia ${picTitle}na ${picUrl}:`,
    sl: `Uporabnik ${commenterName} je dodal komentar k ${own ? 'vaši ' : ''}fotografiji ${picTitle}na ${picUrl}:`,
    fr: `L'utilisateur ${commenterName} a commenté ${own ? 'votre' : 'une'} photo ${picTitle}sur ${picUrl} :`,
  };

  const lang = mailLang(recipient.language);

  await sendWatchedMail({
    recipient,
    target: opts.target,
    targetId: opts.targetId,
    subject: subjects[lang],
    body: `${messages[lang]}\n\n${comment}`,
    web,
  });
}
