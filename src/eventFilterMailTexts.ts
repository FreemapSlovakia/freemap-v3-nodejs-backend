import type { MailLang } from './notificationMail.js';

// Apart from the job, so a test reads them without the database.

export type EventFilterTexts = {
  subject: (name: string) => string;
  /** `name` ready to show: quoted in plain text, HTML in the HTML part. */
  intro: (name: string) => string;
  more: (count: number) => string;
  stop: string;
};

// Formal address wherever a language distinguishes it. Into HTML unescaped:
// no markup characters (see notificationMail.test.ts).
export const EVENT_FILTER_TEXTS: Record<MailLang, EventFilterTexts> = {
  en: {
    subject: (n) => `New events: "${n}"`,
    intro: (n) => `New events matching your saved filter ${n}:`,
    more: (k) => `…and ${k} more`,
    stop: 'Stop emails for this filter',
  },
  sk: {
    subject: (n) => `Nové akcie: „${n}“`,
    intro: (n) => `Nové akcie zodpovedajúce vášmu uloženému filtru ${n}:`,
    more: (k) => `…a ďalších ${k}`,
    stop: 'Zastaviť e-maily pre tento filter',
  },
  cs: {
    subject: (n) => `Nové akce: „${n}“`,
    intro: (n) => `Nové akce odpovídající vašemu uloženému filtru ${n}:`,
    more: (k) => `…a dalších ${k}`,
    stop: 'Zastavit e-maily pro tento filtr',
  },
  hu: {
    subject: (n) => `Új események: „${n}”`,
    intro: (n) =>
      `Új események, amelyek megfelelnek a(z) ${n} mentett szűrőnek:`,
    more: (k) => `…és még ${k}`,
    stop: 'E-mailek leállítása ehhez a szűrőhöz',
  },
  it: {
    subject: (n) => `Nuovi eventi: «${n}»`,
    intro: (n) => `Nuovi eventi che corrispondono al Suo filtro salvato ${n}:`,
    more: (k) => `…e altri ${k}`,
    stop: 'Interrompi le e-mail per questo filtro',
  },
  de: {
    subject: (n) => `Neue Veranstaltungen: „${n}“`,
    intro: (n) => `Neue Veranstaltungen zu Ihrem gespeicherten Filter ${n}:`,
    more: (k) => `…und ${k} weitere`,
    stop: 'E-Mails für diesen Filter abbestellen',
  },
  pl: {
    subject: (n) => `Nowe wydarzenia: „${n}”`,
    intro: (n) => `Nowe wydarzenia pasujące do zapisanego filtra ${n}:`,
    more: (k) => `…i ${k} więcej`,
    stop: 'Wyłącz e-maile dla tego filtra',
  },
  sl: {
    subject: (n) => `Novi dogodki: »${n}«`,
    intro: (n) => `Novi dogodki, ki ustrezajo vašemu shranjenemu filtru ${n}:`,
    more: (k) => `…in še ${k}`,
    stop: 'Ustavi e-pošto za ta filter',
  },
  fr: {
    subject: (n) => `Nouveaux événements : « ${n} »`,
    intro: (n) =>
      `Nouveaux événements correspondant à votre filtre enregistré ${n} :`,
    more: (k) => `…et ${k} de plus`,
    stop: 'Arrêter les e-mails pour ce filtre',
  },
};
