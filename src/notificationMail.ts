import type { Logger } from 'pino';
import { getEnv, getEnvBoolean } from './env.js';
import { appLogger } from './logger.js';
import { sendMail } from './mailer.js';
import { type MailTarget, type Recipient, watchToken } from './mailWatch.js';

export const MAIL_LANGS = [
  'en',
  'sk',
  'cs',
  'hu',
  'it',
  'de',
  'pl',
  'sl',
  'fr',
] as const;

export type MailLang = (typeof MAIL_LANGS)[number];

export const webBaseUrl = getEnv('WEB_BASE_URL').split(',').filter(Boolean)[0];

const apiUrl = getEnv('API_URL', '');

const mailLogger = appLogger.child({ module: 'notificationMail' });

type Texts = {
  commentSubject: (title: string) => string;
  commentIntro: (name: string, title: string, own: boolean) => string;
  goingSubject: (name: string, title: string) => string;
  goingBody: (name: string, title: string, count: number) => string;
  changedSubject: (title: string) => string;
  changedIntro: (title: string) => string;
  start: string;
  end: string;
  moved: string;
  deletedSubject: (title: string) => string;
  deletedBody: (title: string, when: string) => string;
  event: string;
  stopEvent: string;
  stopPhoto: string;
  settings: string;
};

// Formal address wherever a language distinguishes it; see the web repo's
// doc/translations.md.
const TEXTS: Record<MailLang, Texts> = {
  en: {
    commentSubject: (t) => `New comment on the event "${t}"`,
    commentIntro: (n, t, own) =>
      `New comment from ${n} on ${own ? 'your' : 'the'} event "${t}":`,
    goingSubject: (n, t) => `${n} is going to your event "${t}"`,
    goingBody: (n, t, c) =>
      `${n} is going to your event "${t}". Going now: ${c}.`,
    changedSubject: (t) => `The event "${t}" has changed`,
    changedIntro: (t) => `The event "${t}" has changed:`,
    start: 'Start',
    end: 'End',
    moved: 'The start point has moved.',
    deletedSubject: (t) => `The event "${t}" has been deleted`,
    deletedBody: (t, w) =>
      `The event "${t}" (${w}) has been deleted and is no longer on the map.`,
    event: 'Event',
    stopEvent: 'Stop emails about this event',
    stopPhoto: 'Stop emails about this photo',
    settings: 'Email settings',
  },
  sk: {
    commentSubject: (t) => `Nový komentár k akcii „${t}“`,
    commentIntro: (n, t, own) =>
      `Nový komentár od používateľa ${n} k ${own ? 'vašej ' : ''}akcii „${t}“:`,
    goingSubject: (n, t) => `${n} príde na vašu akciu „${t}“`,
    goingBody: (n, t, c) =>
      `Na vašu akciu „${t}“ príde ${n}. Spolu prídu: ${c}.`,
    changedSubject: (t) => `Zmena akcie „${t}“`,
    changedIntro: (t) => `Akcia „${t}“ sa zmenila:`,
    start: 'Začiatok',
    end: 'Koniec',
    moved: 'Miesto štartu sa presunulo.',
    deletedSubject: (t) => `Akcia „${t}“ bola zmazaná`,
    deletedBody: (t, w) =>
      `Akcia „${t}“ (${w}) bola zmazaná a na mape už nie je.`,
    event: 'Akcia',
    stopEvent: 'Nedostávať e-maily o tejto akcii',
    stopPhoto: 'Nedostávať e-maily o tejto fotke',
    settings: 'Nastavenia e-mailov',
  },
  cs: {
    commentSubject: (t) => `Nový komentář k akci „${t}“`,
    commentIntro: (n, t, own) =>
      `Nový komentář od uživatele ${n} k ${own ? 'vaší ' : ''}akci „${t}“:`,
    goingSubject: (n, t) => `${n} přijde na vaši akci „${t}“`,
    goingBody: (n, t, c) =>
      `Na vaši akci „${t}“ přijde ${n}. Celkem přijde: ${c}.`,
    changedSubject: (t) => `Změna akce „${t}“`,
    changedIntro: (t) => `Akce „${t}“ se změnila:`,
    start: 'Začátek',
    end: 'Konec',
    moved: 'Místo startu se přesunulo.',
    deletedSubject: (t) => `Akce „${t}“ byla smazána`,
    deletedBody: (t, w) => `Akce „${t}“ (${w}) byla smazána a na mapě už není.`,
    event: 'Akce',
    stopEvent: 'Nedostávat e-maily o této akci',
    stopPhoto: 'Nedostávat e-maily o této fotce',
    settings: 'Nastavení e-mailů',
  },
  hu: {
    commentSubject: (t) => `Új hozzászólás a(z) „${t}” eseményhez`,
    commentIntro: (n, t, own) =>
      `${n} új hozzászólást írt ${own ? `az Ön „${t}” eseményéhez` : `a(z) „${t}” eseményhez`}:`,
    goingSubject: (n, t) => `${n} részt vesz az Ön „${t}” eseményén`,
    goingBody: (n, t, c) =>
      `${n} részt vesz az Ön „${t}” eseményén. Résztvevők száma: ${c}.`,
    changedSubject: (t) => `Megváltozott a(z) „${t}” esemény`,
    changedIntro: (t) => `A(z) „${t}” esemény megváltozott:`,
    start: 'Kezdés',
    end: 'Vége',
    moved: 'A kiindulópont áthelyeződött.',
    deletedSubject: (t) => `Törölték a(z) „${t}” eseményt`,
    deletedBody: (t, w) =>
      `A(z) „${t}” eseményt (${w}) törölték, és már nem szerepel a térképen.`,
    event: 'Esemény',
    stopEvent: 'Ne kapjon több e-mailt erről az eseményről',
    stopPhoto: 'Ne kapjon több e-mailt erről a fotóról',
    settings: 'E-mail-beállítások',
  },
  it: {
    commentSubject: (t) => `Nuovo commento sull’evento «${t}»`,
    commentIntro: (n, t, own) =>
      `Nuovo commento di ${n} ${own ? `sul Suo evento «${t}»` : `sull’evento «${t}»`}:`,
    goingSubject: (n, t) => `${n} parteciperà al Suo evento «${t}»`,
    goingBody: (n, t, c) =>
      `${n} parteciperà al Suo evento «${t}». Partecipanti: ${c}.`,
    changedSubject: (t) => `L’evento «${t}» è cambiato`,
    changedIntro: (t) => `L’evento «${t}» è cambiato:`,
    start: 'Inizio',
    end: 'Fine',
    moved: 'Il punto di partenza è stato spostato.',
    deletedSubject: (t) => `L’evento «${t}» è stato eliminato`,
    deletedBody: (t, w) =>
      `L’evento «${t}» (${w}) è stato eliminato e non è più sulla mappa.`,
    event: 'Evento',
    stopEvent: 'Non ricevere più email su questo evento',
    stopPhoto: 'Non ricevere più email su questa foto',
    settings: 'Impostazioni email',
  },
  de: {
    commentSubject: (t) => `Neuer Kommentar zur Veranstaltung „${t}“`,
    commentIntro: (n, t, own) =>
      `Neuer Kommentar von ${n} zu ${own ? 'Ihrer' : 'der'} Veranstaltung „${t}“:`,
    goingSubject: (n, t) => `${n} nimmt an Ihrer Veranstaltung „${t}“ teil`,
    goingBody: (n, t, c) =>
      `${n} nimmt an Ihrer Veranstaltung „${t}“ teil. Zusagen insgesamt: ${c}.`,
    changedSubject: (t) => `Änderung der Veranstaltung „${t}“`,
    changedIntro: (t) => `Die Veranstaltung „${t}“ wurde geändert:`,
    start: 'Beginn',
    end: 'Ende',
    moved: 'Der Startpunkt wurde verlegt.',
    deletedSubject: (t) => `Die Veranstaltung „${t}“ wurde gelöscht`,
    deletedBody: (t, w) =>
      `Die Veranstaltung „${t}“ (${w}) wurde gelöscht und ist nicht mehr auf der Karte.`,
    event: 'Veranstaltung',
    stopEvent: 'Keine E-Mails mehr zu dieser Veranstaltung',
    stopPhoto: 'Keine E-Mails mehr zu diesem Foto',
    settings: 'E-Mail-Einstellungen',
  },
  pl: {
    commentSubject: (t) => `Nowy komentarz do wydarzenia „${t}”`,
    commentIntro: (n, t) => `Nowy komentarz od ${n} do wydarzenia „${t}”:`,
    goingSubject: (n, t) => `${n} weźmie udział w wydarzeniu „${t}”`,
    goingBody: (n, t, c) =>
      `${n} weźmie udział w wydarzeniu „${t}”. Łącznie uczestników: ${c}.`,
    changedSubject: (t) => `Zmiana wydarzenia „${t}”`,
    changedIntro: (t) => `Wydarzenie „${t}” zostało zmienione:`,
    start: 'Początek',
    end: 'Koniec',
    moved: 'Miejsce startu zostało przeniesione.',
    deletedSubject: (t) => `Wydarzenie „${t}” zostało usunięte`,
    deletedBody: (t, w) =>
      `Wydarzenie „${t}” (${w}) zostało usunięte i nie ma go już na mapie.`,
    event: 'Wydarzenie',
    stopEvent: 'Rezygnacja z e-maili o tym wydarzeniu',
    stopPhoto: 'Rezygnacja z e-maili o tym zdjęciu',
    settings: 'Ustawienia e-maili',
  },
  sl: {
    commentSubject: (t) => `Nov komentar k dogodku »${t}«`,
    commentIntro: (n, t, own) =>
      `Nov komentar uporabnika ${n} k ${own ? 'vašemu ' : ''}dogodku »${t}«:`,
    goingSubject: (n, t) => `Na vaš dogodek »${t}« pride ${n}`,
    goingBody: (n, t, c) =>
      `Na vaš dogodek »${t}« pride ${n}. Skupaj udeležencev: ${c}.`,
    changedSubject: (t) => `Sprememba dogodka »${t}«`,
    changedIntro: (t) => `Dogodek »${t}« se je spremenil:`,
    start: 'Začetek',
    end: 'Konec',
    moved: 'Izhodišče je bilo premaknjeno.',
    deletedSubject: (t) => `Dogodek »${t}« je bil izbrisan`,
    deletedBody: (t, w) =>
      `Dogodek »${t}« (${w}) je bil izbrisan in ga ni več na zemljevidu.`,
    event: 'Dogodek',
    stopEvent: 'Odjava od e-pošte o tem dogodku',
    stopPhoto: 'Odjava od e-pošte o tej fotografiji',
    settings: 'Nastavitve e-pošte',
  },
  fr: {
    commentSubject: (t) => `Nouveau commentaire sur l’événement « ${t} »`,
    commentIntro: (n, t, own) =>
      `Nouveau commentaire de ${n} sur ${own ? 'votre événement' : 'l’événement'} « ${t} » :`,
    goingSubject: (n, t) => `${n} participe à votre événement « ${t} »`,
    goingBody: (n, t, c) =>
      `${n} participe à votre événement « ${t} ». Participants : ${c}.`,
    changedSubject: (t) => `L’événement « ${t} » a changé`,
    changedIntro: (t) => `L’événement « ${t} » a changé :`,
    start: 'Début',
    end: 'Fin',
    moved: 'Le point de départ a été déplacé.',
    deletedSubject: (t) => `L’événement « ${t} » a été supprimé`,
    deletedBody: (t, w) =>
      `L’événement « ${t} » (${w}) a été supprimé et n’apparaît plus sur la carte.`,
    event: 'Événement',
    stopEvent: 'Ne plus recevoir d’e-mails sur cet événement',
    stopPhoto: 'Ne plus recevoir d’e-mails sur cette photo',
    settings: 'Paramètres des e-mails',
  },
};

export function mailLang(lang: string | null | undefined): MailLang {
  return MAIL_LANGS.includes(lang as MailLang) ? (lang as MailLang) : 'en';
}

export function mailTexts(lang: string | null | undefined): Texts {
  return TEXTS[mailLang(lang)];
}

/** An event's dates as a recipient reads them; a date-only one has no time. */
export function formatEventTime(
  lang: string | null | undefined,
  at: Date,
  dateOnly: boolean,
): string {
  return new Intl.DateTimeFormat(mailLang(lang), {
    dateStyle: 'medium',
    ...(dateOnly
      ? { timeZone: 'UTC' }
      : // The events are European; their stored times are UTC.
        { timeStyle: 'short', timeZone: 'Europe/Bratislava' }),
  }).format(at);
}

export const eventUrl = (id: string) => `${webBaseUrl}/#panel=event/${id}`;

export const userUrl = (id: number, web = webBaseUrl) =>
  `${web}/#show=user/${id}`;

/** Text for HTML; the texts' own wording holds no markup characters. */
export const esc = (s: string) =>
  s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

/** A name or title as the HTML mail shows it: italic, linking where it leads. */
export const htmlRef = (text: string, href?: string) =>
  href
    ? `<a href="${esc(href)}"><i>${esc(text)}</i></a>`
    : `<i>${esc(text)}</i>`;

/** A paragraph of HTML already escaped where it needs to be. */
export const htmlPara = (html: string) => `<p>${html}</p>`;

/** User-written text, its line breaks kept. */
export const htmlQuote = (text: string) =>
  `<blockquote style="margin:0;padding-left:12px;border-left:3px solid #ccc">${text
    .split(/\r?\n/)
    .map(esc)
    .join('<br>')}</blockquote>`;

/**
 * Sends one email: `body` and a footer letting the recipient stop the emails
 * about this target, with the matching one-click `List-Unsubscribe`. `html`,
 * the same as HTML blocks (`htmlPara`, `htmlQuote`), makes it multipart.
 */
export async function sendWatchedMail(opts: {
  recipient: Recipient;
  target: MailTarget;
  targetId: string | number;
  subject: string;
  body: string;
  html?: string[];
  /** The site the links lead to; by default the first `WEB_BASE_URL`. */
  web?: string;
}) {
  const { recipient, target, targetId, subject, body, web = webBaseUrl } = opts;

  const texts = mailTexts(recipient.language);

  const token = watchToken(recipient.id, target, targetId);

  const settingsUrl = `${web}/#show=account/notifications`;

  const stopUrl = token ? `${web}/#show=mail-watch/${token}` : settingsUrl;

  const footer = [
    `${target === 'event' ? texts.stopEvent : texts.stopPhoto}: ${stopUrl}`,
    `${texts.settings}: ${settingsUrl}`,
  ].join('\n');

  const text = `${body}\n\n-- \n${footer}`;

  const stopLabel = target === 'event' ? texts.stopEvent : texts.stopPhoto;

  const html =
    opts.html &&
    [
      '<!doctype html><html><body style="font-family:sans-serif;font-size:15px;line-height:1.4">',
      ...opts.html,
      `<hr style="border:0;border-top:1px solid #ddd"><p style="font-size:13px;color:#666"><a href="${esc(stopUrl)}">${esc(stopLabel)}</a> · <a href="${esc(settingsUrl)}">${esc(texts.settings)}</a></p>`,
      '</body></html>',
    ].join('\n');

  const headers: Record<string, string> =
    token && apiUrl
      ? {
          'List-Unsubscribe': `<${apiUrl}/mail-watch/unsubscribe?token=${token}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        }
      : {};

  // Development: the whole mail in the log, nothing sent.
  if (!getEnvBoolean('MAILGUN_ENABLE', false)) {
    mailLogger.info(
      { to: recipient.email, subject, text, html, headers },
      'MAILGUN_ENABLE is off — not sending',
    );

    return;
  }

  await sendMail(
    recipient.email,
    subject,
    text,
    // One stalled send must not hold up the rest of its batch for good.
    30_000,
    headers,
    html,
  );
}

/**
 * Mails each recipient in turn, after the request: a failure is logged, never
 * the request's.
 */
export function mailInBackground(
  logger: Logger,
  recipients: Recipient[],
  send: (recipient: Recipient) => Promise<void>,
) {
  if (!recipients.length) {
    return;
  }

  void (async () => {
    for (const recipient of recipients) {
      try {
        await send(recipient);
      } catch (err) {
        logger.error({ err, to: recipient.email }, 'notification mail failed');
      }
    }
  })();
}
