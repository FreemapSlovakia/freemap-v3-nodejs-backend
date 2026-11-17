// The login and confirmation code emails' texts, apart from emailCodes so a
// test can read them without a database.

import { esc } from './mailHtml.js';

export type EmailCodePurpose = 'login' | 'change';

export const CODE_TTL_MINUTES = 10;

/**
 * What entering the code will do beyond the obvious: `newAccount` for a login
 * code no account's verified address matches, `joins` for a confirmation code
 * another account's verified address does.
 */
export type EmailCodeNote = 'newAccount' | 'joins';

export type EmailCodeTranslation = {
  subject: Record<EmailCodePurpose, string>;
  code: (code: string) => string;
  notes: Record<EmailCodeNote, string>;
  ignore: string;
};

export const emailCodeTranslations: Record<string, EmailCodeTranslation> = {
  en: {
    subject: {
      login: 'Freemap login code',
      change: 'Freemap email confirmation code',
    },
    code: (code) =>
      `Your code is ${code}. It is valid for ${CODE_TTL_MINUTES} minutes.`,
    notes: {
      newAccount:
        'No Freemap account has this address confirmed yet, so logging in with this code creates a new account. If you already have an account that you log in to another way (for example with Google), log in there instead and confirm this address in your account.',
      joins:
        'Someone signed in to a Freemap account asked to confirm this address for that account, but another Freemap account already has it confirmed. Entering the code joins the two accounts: the maps, photos, purchases and login methods of both end up in the older one. Enter it only if both accounts are yours, and never give this code to anyone.',
    },
    ignore: 'If you did not ask for it, ignore this email.',
  },
  sk: {
    subject: {
      login: 'Prihlasovací kód Freemap',
      change: 'Kód na potvrdenie e-mailu Freemap',
    },
    code: (code) => `Váš kód je ${code}. Platí ${CODE_TTL_MINUTES} minút.`,
    notes: {
      newAccount:
        'Túto adresu zatiaľ nemá potvrdenú žiadny účet Freemap, takže prihlásením týmto kódom vznikne nový účet. Ak už máte účet, do ktorého sa prihlasujete inak (napríklad cez Google), prihláste sa radšej doň a túto adresu potvrďte vo svojom účte.',
      joins:
        'Niekto prihlásený do účtu Freemap požiadal o potvrdenie tejto adresy pre ten účet, no iný účet Freemap ju už má potvrdenú. Zadaním kódu sa tieto dva účty zlúčia: mapy, fotografie, nákupy a spôsoby prihlásenia oboch prejdú do staršieho z nich. Zadajte ho, len ak sú oba účty vaše, a tento kód nikomu nedávajte.',
    },
    ignore: 'Ak ste oň nežiadali, tento e-mail ignorujte.',
  },
  cs: {
    subject: {
      login: 'Přihlašovací kód Freemap',
      change: 'Kód pro potvrzení e-mailu Freemap',
    },
    code: (code) => `Váš kód je ${code}. Platí ${CODE_TTL_MINUTES} minut.`,
    notes: {
      newAccount:
        'Tuto adresu zatím nemá potvrzenou žádný účet Freemap, takže přihlášením tímto kódem vznikne nový účet. Pokud už máte účet, do kterého se přihlašujete jinak (například přes Google), přihlaste se raději do něj a tuto adresu potvrďte ve svém účtu.',
      joins:
        'Někdo přihlášený do účtu Freemap požádal o potvrzení této adresy pro ten účet, ale jiný účet Freemap ji už má potvrzenou. Zadáním kódu se tyto dva účty sloučí: mapy, fotografie, nákupy a způsoby přihlášení obou přejdou do staršího z nich. Zadejte jej, jen pokud jsou oba účty vaše, a tento kód nikomu nedávejte.',
    },
    ignore: 'Pokud jste o něj nežádali, tento e-mail ignorujte.',
  },
  de: {
    subject: {
      login: 'Freemap-Anmeldecode',
      change: 'Freemap-Code zur Bestätigung der E-Mail-Adresse',
    },
    code: (code) =>
      `Ihr Code lautet ${code}. Er ist ${CODE_TTL_MINUTES} Minuten lang gültig.`,
    notes: {
      newAccount:
        'Noch kein Freemap-Konto hat diese Adresse bestätigt, daher wird bei der Anmeldung mit diesem Code ein neues Konto angelegt. Wenn Sie bereits ein Konto haben, bei dem Sie sich anders anmelden (zum Beispiel mit Google), melden Sie sich stattdessen dort an und bestätigen Sie diese Adresse in Ihrem Konto.',
      joins:
        'Jemand, der bei einem Freemap-Konto angemeldet ist, möchte diese Adresse für jenes Konto bestätigen, aber ein anderes Freemap-Konto hat sie bereits bestätigt. Mit der Eingabe des Codes werden die beiden Konten zusammengeführt: Karten, Fotos, Käufe und Anmeldemethoden beider landen im älteren. Geben Sie ihn nur ein, wenn beide Konten Ihnen gehören, und geben Sie diesen Code niemandem weiter.',
    },
    ignore:
      'Falls Sie ihn nicht angefordert haben, ignorieren Sie diese E-Mail.',
  },
  fr: {
    subject: {
      login: 'Code de connexion Freemap',
      change: 'Code de confirmation de l’adresse e-mail Freemap',
    },
    code: (code) =>
      `Votre code est ${code}. Il est valable ${CODE_TTL_MINUTES} minutes.`,
    notes: {
      newAccount:
        'Aucun compte Freemap n’a encore confirmé cette adresse : se connecter avec ce code crée donc un nouveau compte. Si vous avez déjà un compte auquel vous vous connectez autrement (par exemple avec Google), connectez-vous plutôt à celui-ci et confirmez cette adresse dans votre compte.',
      joins:
        'Une personne connectée à un compte Freemap a demandé à confirmer cette adresse pour ce compte, mais un autre compte Freemap l’a déjà confirmée. Saisir le code fusionne les deux comptes : les cartes, photos, achats et méthodes de connexion des deux se retrouvent dans le plus ancien. Ne le saisissez que si les deux comptes sont à vous, et ne communiquez ce code à personne.',
    },
    ignore: 'Si vous ne l’avez pas demandé, ignorez cet e-mail.',
  },
  hu: {
    subject: {
      login: 'Freemap belépési kód',
      change: 'Freemap e-mail-cím megerősítő kód',
    },
    code: (code) =>
      `Az Ön kódja: ${code}. ${CODE_TTL_MINUTES} percig érvényes.`,
    notes: {
      newAccount:
        'Ezt a címet még egyetlen Freemap-fiók sem erősítette meg, ezért az ezzel a kóddal való belépés új fiókot hoz létre. Ha már van olyan fiókja, amelybe másként lép be (például Google-lel), inkább oda lépjen be, és ott erősítse meg ezt a címet.',
      joins:
        'Valaki, aki be van lépve egy Freemap-fiókba, kérte ennek a címnek a megerősítését ahhoz a fiókhoz, de egy másik Freemap-fiók már megerősítette. A kód megadásával a két fiók összevonásra kerül: mindkettő térképei, fotói, vásárlásai és belépési módjai a régebbibe kerülnek. Csak akkor adja meg, ha mindkét fiók az Öné, és ezt a kódot senkinek ne adja ki.',
    },
    ignore: 'Ha nem Ön kérte, hagyja figyelmen kívül ezt az e-mailt.',
  },
  it: {
    subject: {
      login: 'Codice di accesso Freemap',
      change: 'Codice di conferma dell’e-mail Freemap',
    },
    code: (code) =>
      `Il suo codice è ${code}. È valido per ${CODE_TTL_MINUTES} minuti.`,
    notes: {
      newAccount:
        'Nessun account Freemap ha ancora confermato questo indirizzo, quindi l’accesso con questo codice crea un nuovo account. Se ha già un account a cui accede in altro modo (ad esempio con Google), acceda invece a quello e confermi questo indirizzo nel suo account.',
      joins:
        'Qualcuno che ha effettuato l’accesso a un account Freemap ha chiesto di confermare questo indirizzo per quell’account, ma un altro account Freemap lo ha già confermato. Inserendo il codice i due account verranno uniti: mappe, foto, acquisti e metodi di accesso di entrambi finiranno nel più vecchio. Lo inserisca solo se entrambi gli account sono suoi, e non comunichi questo codice a nessuno.',
    },
    ignore: 'Se non l’ha richiesto, ignori questa e-mail.',
  },
  pl: {
    subject: {
      login: 'Kod logowania Freemap',
      change: 'Kod potwierdzenia adresu e-mail Freemap',
    },
    code: (code) => `Kod: ${code}. Jest ważny przez ${CODE_TTL_MINUTES} minut.`,
    notes: {
      newAccount:
        'Żadne konto Freemap nie ma jeszcze potwierdzonego tego adresu, więc zalogowanie się tym kodem utworzy nowe konto. Jeśli istnieje już konto, do którego logowanie odbywa się inaczej (na przykład przez Google), lepiej zalogować się do niego i potwierdzić ten adres w ustawieniach konta.',
      joins:
        'Ktoś zalogowany na konto Freemap poprosił o potwierdzenie tego adresu dla tamtego konta, ale inne konto Freemap ma go już potwierdzony. Wpisanie kodu scali oba konta: mapy, zdjęcia, zakupy i sposoby logowania obu trafią do starszego. Kod należy wpisać tylko wtedy, gdy oba konta należą do odbiorcy tej wiadomości, i nikomu go nie przekazywać.',
    },
    ignore: 'Jeśli kod nie był zamawiany, prosimy zignorować tę wiadomość.',
  },
  sl: {
    subject: {
      login: 'Prijavna koda Freemap',
      change: 'Koda za potrditev e-pošte Freemap',
    },
    code: (code) => `Vaša koda je ${code}. Velja ${CODE_TTL_MINUTES} minut.`,
    notes: {
      newAccount:
        'Tega naslova še noben račun Freemap nima potrjenega, zato prijava s to kodo ustvari nov račun. Če že imate račun, v katerega se prijavljate drugače (na primer z Googlom), se raje prijavite vanj in ta naslov potrdite v svojem računu.',
      joins:
        'Nekdo, ki je prijavljen v račun Freemap, je zahteval potrditev tega naslova za tisti račun, vendar je ta naslov že potrjen v drugem računu Freemap. Z vnosom kode se računa združita: zemljevidi, fotografije, nakupi in načini prijave obeh preidejo v starejši račun. Vnesite jo le, če sta oba računa vaša, in te kode ne dajte nikomur.',
    },
    ignore: 'Če je niste zahtevali, to sporočilo prezrite.',
  },
};

// Stands in for the code while its sentence is escaped; a private-use char
// no translation holds.
const CODE_SLOT = String.fromCharCode(0xe000);

/** The code sentence for the HTML part: escaped whole, the code made to stand out. */
export function codeHtml(t: EmailCodeTranslation, code: string) {
  return esc(t.code(CODE_SLOT)).replace(
    CODE_SLOT,
    () =>
      `<b style="font-family:monospace;font-size:1.4em;letter-spacing:0.1em">${code}</b>`,
  );
}
