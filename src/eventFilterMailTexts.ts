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
    subject: (n) => `Events for "${n}"`,
    intro: (n) => `Events that now match your saved filter ${n}:`,
    more: (k) => `…and ${k} more`,
    stop: 'Stop emails for this filter',
  },
  sk: {
    subject: (n) => `Akcie pre „${n}“`,
    intro: (n) => `Akcie, ktoré teraz zodpovedajú vášmu uloženému filtru ${n}:`,
    more: (k) => `…a ďalších ${k}`,
    stop: 'Zastaviť e-maily pre tento filter',
  },
  cs: {
    subject: (n) => `Akce pro „${n}“`,
    intro: (n) => `Akce, které nyní odpovídají vašemu uloženému filtru ${n}:`,
    more: (k) => `…a dalších ${k}`,
    stop: 'Zastavit e-maily pro tento filtr',
  },
  hu: {
    subject: (n) => `Események: „${n}”`,
    intro: (n) =>
      `Események, amelyek most megfelelnek a(z) ${n} mentett szűrőnek:`,
    more: (k) => `…és még ${k}`,
    stop: 'E-mailek leállítása ehhez a szűrőhöz',
  },
  it: {
    subject: (n) => `Eventi per «${n}»`,
    intro: (n) => `Eventi che ora corrispondono al Suo filtro salvato ${n}:`,
    more: (k) => `…e altri ${k}`,
    stop: 'Interrompi le e-mail per questo filtro',
  },
  de: {
    subject: (n) => `Veranstaltungen zu „${n}“`,
    intro: (n) =>
      `Veranstaltungen, die jetzt zu Ihrem gespeicherten Filter ${n} passen:`,
    more: (k) => `…und ${k} weitere`,
    stop: 'E-Mails für diesen Filter abbestellen',
  },
  pl: {
    subject: (n) => `Wydarzenia: „${n}”`,
    intro: (n) => `Wydarzenia, które teraz pasują do zapisanego filtra ${n}:`,
    more: (k) => `…i ${k} więcej`,
    stop: 'Wyłącz e-maile dla tego filtra',
  },
  sl: {
    subject: (n) => `Dogodki: »${n}«`,
    intro: (n) => `Dogodki, ki zdaj ustrezajo vašemu shranjenemu filtru ${n}:`,
    more: (k) => `…in še ${k}`,
    stop: 'Ustavi e-pošto za ta filter',
  },
  fr: {
    subject: (n) => `Événements : « ${n} »`,
    intro: (n) =>
      `Événements qui correspondent désormais à votre filtre enregistré ${n} :`,
    more: (k) => `…et ${k} de plus`,
    stop: 'Arrêter les e-mails pour ce filtre',
  },
};
