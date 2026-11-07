import {
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from 'node:crypto';
import type { ParameterizedContext } from 'koa';
import sql from 'sql-template-tag';
import z from 'zod';
import { pool, runInTransaction } from './database.js';
import { normalizeEmail } from './emailAddress.js';
import { getEnvBoolean } from './env.js';
import { pickLanguage, sendMail } from './mailer.js';

export type EmailCodePurpose = 'login' | 'change';

const CODE_TTL_MINUTES = 10;

const MAX_ATTEMPTS = 5;

const MIN_RESEND_SECONDS = 60;

const MAX_PER_ADDRESS_PER_HOUR = 5;

const MAX_PER_IP_PER_HOUR = 20;

// Comparisons against an address's codes, all of them: 20 a day keep a 6-digit
// code's yearly odds of being guessed under 1%.
const MAX_GUESSES_PER_ADDRESS_PER_DAY = 20;

const HOUR_MS = 3_600_000;

const DAY_MS = 24 * HOUR_MS;

// In memory: the API runs as one process, and a restart only resets the caps.
const sendsByIp = new Map<string, number[]>();

const guessesByAddress = new Map<string, number[]>();

// Else every IP and address that ever asked stays in memory.
setInterval(() => {
  const now = Date.now();

  for (const [map, window] of [
    [sendsByIp, HOUR_MS],
    [guessesByAddress, DAY_MS],
  ] as const) {
    for (const [key, times] of map) {
      if (times.every((t) => t <= now - window)) {
        map.delete(key);
      }
    }
  }
}, 600_000).unref();

/**
 * Records one occurrence under `key` unless `max` happened within `window`,
 * returning what gives it back. Synchronous, so parallel requests can't all
 * pass between check and count.
 */
function takeSlot(
  map: Map<string, number[]>,
  key: string,
  max: number,
  window: number,
): (() => void) | undefined {
  const now = Date.now();

  const recent = (map.get(key) ?? []).filter((t) => t > now - window);

  if (recent.length >= max) {
    return undefined;
  }

  recent.push(now);

  map.set(key, recent);

  return () => {
    const times = map.get(key);

    const index = times?.indexOf(now) ?? -1;

    if (index >= 0) {
      times!.splice(index, 1);
    }
  };
}

/**
 * What entering the code will do beyond the obvious: `newAccount` for a login
 * code no account's verified address matches, `joins` for a confirmation code
 * another account's verified address does.
 */
export type EmailCodeNote = 'newAccount' | 'joins';

type Translation = {
  subject: Record<EmailCodePurpose, string>;
  code: (code: string) => string;
  notes: Record<EmailCodeNote, string>;
  ignore: string;
};

const translations: Record<string, Translation> = {
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

// Keyed, and never stored: a plain hash of a 6-digit code is reversed from a
// table of a million. A restart voids live codes, which last minutes anyway.
const CODE_KEY = randomBytes(32);

function hashCode(code: string) {
  return createHmac('sha256', CODE_KEY).update(code).digest();
}

function clientIp(ctx: ParameterizedContext) {
  // Set by nginx from the peer address; the API listens on loopback only.
  return ctx.get('x-real-ip') || ctx.ip;
}

/** Sends a fresh code to `email`; throws 429 past the send limits. */
export async function sendEmailCode(
  ctx: ParameterizedContext,
  purpose: EmailCodePurpose,
  email: string,
  language: string | null | undefined,
  userId: number | null = null,
  /** Asked only once the limits let the code go out. */
  note?: () => Promise<EmailCodeNote | undefined>,
) {
  const emailKey = normalizeEmail(email);

  // Given back on any failure: nothing went out, so a retry mustn't use up
  // the IP.
  const releaseIpSlot = takeSlot(
    sendsByIp,
    clientIp(ctx),
    MAX_PER_IP_PER_HOUR,
    HOUR_MS,
  );

  if (!releaseIpSlot) {
    ctx.throw(429, 'too many codes');
  }

  try {
    await storeAndSend(ctx, purpose, email, emailKey, language, userId, note);
  } catch (err) {
    releaseIpSlot();

    throw err;
  }
}

async function storeAndSend(
  ctx: ParameterizedContext,
  purpose: EmailCodePurpose,
  email: string,
  emailKey: string,
  language: string | null | undefined,
  userId: number | null,
  noteOf: (() => Promise<EmailCodeNote | undefined>) | undefined,
) {
  const code = String(randomInt(1_000_000)).padStart(6, '0');

  // Inserted before counting, so parallel requests see each other's rows; on
  // a race every one of them may refuse, never all pass.
  const { insertId } = await pool.query<{ insertId: number }>(
    sql`INSERT INTO emailCode SET
      purpose = ${purpose},
      userId = ${userId},
      email = ${email},
      emailKey = ${emailKey},
      codeHash = ${hashCode(code)},
      requestIp = ${clientIp(ctx)},
      expireAt = NOW() + INTERVAL ${CODE_TTL_MINUTES} MINUTE`,
  );

  // Compared in SQL, against the clock createdAt was stamped with. The gap is
  // between resends of one purpose: a login right after a confirmation is fine.
  const [{ count, recent }] = z
    .array(z.object({ count: z.number(), recent: z.coerce.boolean() }))
    .parse(
      await pool.query<unknown[]>(
        sql`SELECT COUNT(*) AS count,
            COALESCE(MAX(purpose = ${purpose} AND createdAt > NOW() - INTERVAL ${MIN_RESEND_SECONDS} SECOND), 0) AS recent
          FROM emailCode
          WHERE emailKey = ${emailKey} AND id <> ${insertId}
            AND createdAt > NOW() - INTERVAL 1 HOUR`,
      ),
    );

  if (count >= MAX_PER_ADDRESS_PER_HOUR || recent) {
    await pool.query<unknown>(
      sql`DELETE FROM emailCode WHERE id = ${insertId}`,
    );

    ctx.throw(429, 'too many codes');
  }

  const t = translations[pickLanguage(ctx, language, translations)]!;

  let note: EmailCodeNote | undefined;

  // Advice only: without it the code still goes out.
  try {
    note = await noteOf?.();
  } catch (err) {
    ctx.log.warn({ err }, 'email code note lookup failed');
  }

  if (getEnvBoolean('MAILGUN_ENABLE', false)) {
    try {
      await sendMail(
        email,
        t.subject[purpose],
        [t.code(code), note && t.notes[note], t.ignore]
          .filter(Boolean)
          .join('\n\n'),
      );
    } catch (err) {
      // An undelivered code must not hold up the retry.
      await pool.query<unknown>(
        sql`DELETE FROM emailCode WHERE id = ${insertId}`,
      );

      throw err;
    }
  } else {
    ctx.log.warn(
      { email, code, note },
      'MAILGUN_ENABLE is off — not mailing the code',
    );
  }

  // Once it's out: the requester's own resend leaves one live code, so a
  // guess costs one try. Another requester's codes stay, not to void theirs.
  await pool.query<unknown>(
    sql`UPDATE emailCode SET expireAt = NOW()
      WHERE emailKey = ${emailKey} AND purpose = ${purpose} AND userId <=> ${userId}
        AND requestIp = ${clientIp(ctx)} AND id <> ${insertId} AND expireAt > NOW()`,
  );
}

/**
 * Spends `code` if it is one of the live codes sent to `email` for this
 * purpose (and user) — any of them, so a code someone else requests doesn't
 * void the owner's; else throws 403, or 429 past the daily guess cap. A guess
 * counts against every live code and that cap.
 */
export async function checkEmailCode(
  ctx: ParameterizedContext,
  purpose: EmailCodePurpose,
  email: string,
  code: string,
  userId: number | null = null,
): Promise<void> {
  const emailKey = normalizeEmail(email);

  // Not 403: the code may well be right, and the user should be told to wait.
  const takeGuess = () => {
    if (
      !takeSlot(
        guessesByAddress,
        emailKey,
        MAX_GUESSES_PER_ADDRESS_PER_DAY,
        DAY_MS,
      )
    ) {
      ctx.throw(429, 'too many attempts');
    }
  };

  takeGuess();

  const live = sql`emailKey = ${emailKey} AND purpose = ${purpose}
    AND userId <=> ${userId} AND expireAt > NOW() AND attempts < ${MAX_ATTEMPTS}`;

  // Read and counted under the lock, so parallel guesses can't all pass the
  // per-code limit; committed before comparing, so a wrong guess counts.
  const rows = await runInTransaction(async (conn) => {
    const locked = z
      .array(z.object({ id: z.uint32(), codeHash: z.instanceof(Buffer) }))
      .parse(
        await conn.query<unknown[]>(
          sql`SELECT id, codeHash FROM emailCode WHERE ${live} FOR UPDATE`,
        ),
      );

    await conn.query<unknown>(
      sql`UPDATE emailCode SET attempts = attempts + 1 WHERE ${live}`,
    );

    return locked;
  });

  // A guess against several live codes is that many tries at the cap: one was
  // taken above, before the first await, the rest here, outside the retried
  // transaction so a retry doesn't count them again.
  for (let i = 1; i < rows.length; i++) {
    takeGuess();
  }

  const hash = hashCode(code);

  const matchId = rows.find((row) => timingSafeEqual(hash, row.codeHash))?.id;

  if (matchId === undefined) {
    ctx.throw(403, 'invalid code');
  }

  // Conditional, so of concurrent correct submissions only one passes.
  const { affectedRows } = await pool.query<{ affectedRows: number }>(
    sql`UPDATE emailCode SET expireAt = NOW() WHERE id = ${matchId} AND expireAt > NOW()`,
  );

  if (affectedRows !== 1) {
    ctx.throw(403, 'invalid code');
  }

  await pool.query<unknown>(
    sql`UPDATE emailCode SET expireAt = NOW()
      WHERE emailKey = ${emailKey} AND purpose = ${purpose} AND userId <=> ${userId} AND expireAt > NOW()`,
  );
}
