import { sendMail } from '../../mailer.js';

export type CommentLang =
  | 'sk'
  | 'cs'
  | 'en'
  | 'hu'
  | 'it'
  | 'de'
  | 'pl'
  | 'sl'
  | 'fr';

export const COMMENT_MAIL_LANGS: CommentLang[] = [
  'en',
  'sk',
  'cs',
  'hu',
  'it',
  'de',
  'pl',
  'sl',
  'fr',
];

/**
 * Sends a photo-comment notification email in the recipient's language.
 * Shared by gallery and Wikimedia comments; `picTitle` is a pre-quoted title
 * with a trailing space (e.g. `"Foo" `) or `''` when unknown, and `own` marks
 * the photo's own uploader (never set for Wikimedia photos).
 */
export async function sendCommentMail(opts: {
  to: string;
  own: boolean;
  lang: string;
  commenterName: string;
  comment: string;
  webBaseUrl: string;
  picUrl: string;
  picTitle: string;
}): Promise<void> {
  const {
    to,
    own,
    lang,
    commenterName,
    comment,
    webBaseUrl,
    picUrl,
    picTitle,
  } = opts;

  const webUrl = webBaseUrl.replace(/^https?:\/\//, '');

  const unsubscribeUrl = webBaseUrl;

  const subjects: Record<CommentLang, string> = {
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

  const messages: Record<CommentLang, string> = {
    sk: `Používateľ ${commenterName} pridal komentár k ${own ? 'vašej ' : ''}fotke ${picTitle}na ${picUrl}:`,
    cs: `Uživatel ${commenterName} přidal komentář k ${own ? 'vaší ' : ''}fotce ${picTitle}na ${picUrl}:`,
    en: `User ${commenterName} commented ${own ? 'your' : 'a'} photo ${picTitle}at ${picUrl}:`,
    hu: `A felhasználó ${commenterName} hozzászólt ${own ? 'az ön' : 'egy'} fotójához: ${picTitle}${picUrl}:`,
    it: `L'utente ${commenterName} ha commentato ${own ? 'la tua' : 'una'} foto ${picTitle}su ${picUrl}:`,
    de: `Benutzer ${commenterName} hat ${own ? 'dein' : 'ein'} Foto kommentiert: ${picTitle}${picUrl}:`,
    pl: `Użytkownik ${commenterName} dodał komentarz do ${own ? 'twojego' : 'zdjęcia'} ${picTitle}na ${picUrl}:`,
    sl: `Uporabnik ${commenterName} je dodal komentar k ${own ? 'vaši ' : ''}fotografiji ${picTitle}na ${picUrl}:`,
    fr: `L'utilisateur ${commenterName} a commenté ${own ? 'votre' : 'une'} photo ${picTitle}sur ${picUrl} :`,
  };

  const footers: Record<CommentLang, string> = {
    sk: `Ak si už neprajete dostávať upozornenia na komentáre k fotkám, odškrtnite si to na ${unsubscribeUrl} v menu Fotografie.`,
    cs: `Pokud si již nepřejete dostávat upozornění na komentáře k fotkám, odškrtnite si to na ${unsubscribeUrl} v menu Fotografie.`,
    en: `If you no longer wish to be notified about photo comments, uncheck it at ${unsubscribeUrl} in the Photos menu.`,
    hu: `Ha nem szeretne több értesítést kapni a fotókhoz fűzött hozzászólásokról, kapcsolja ki a beállítást a Fotók menüben: ${unsubscribeUrl}.`,
    it: `Se non desideri più ricevere notifiche sui commenti alle foto, disattiva l'opzione nel menu Foto: ${unsubscribeUrl}.`,
    de: `Wenn du keine Benachrichtigungen über Fotokommentare mehr erhalten möchtest, deaktiviere dies im Menü „Fotos“ unter ${unsubscribeUrl}.`,
    pl: `Jeśli nie chcesz otrzymywać powiadomień o komentarzach do zdjęć, odznacz to w menu Zdjęcia pod adresem ${unsubscribeUrl}.`,
    sl: `Če ne želite več prejemati obvestil o komentarjih k fotografijam, to odznačite na ${unsubscribeUrl} v meniju Fotografije.`,
    fr: `Si vous ne souhaitez plus recevoir de notifications sur les commentaires des photos, décochez cette option dans le menu Photos sur ${unsubscribeUrl}.`,
  };

  await sendMail(
    to,
    subjects[lang as CommentLang] ?? subjects.en,
    `${messages[lang as CommentLang] ?? messages.en}\n\n${comment}\n\n${footers[lang as CommentLang] ?? footers.en}`,
  );
}
