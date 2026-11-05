import sql from 'sql-template-tag';

// Providers delivering `user+tag@` to `user@`. Not Yahoo: in its `base-tag@`
// the base is chosen freely and may be another user's ID.
const SUBADDRESS_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'proton.me',
  'protonmail.com',
  'pm.me',
  'fastmail.com',
]);

/**
 * The key two addresses delivering to the same mailbox share. Only providers
 * known to alias are folded; elsewhere `+` and dots may name another mailbox.
 */
export function normalizeEmail(email: string): string {
  const lower = email.trim().toLowerCase();

  const at = lower.lastIndexOf('@');

  // Some stored ones predate validation.
  if (at < 0) {
    return lower;
  }

  let local = lower.slice(0, at);

  let domain = lower.slice(at + 1);

  if (SUBADDRESS_DOMAINS.has(domain)) {
    const index = local.indexOf('+');

    if (index > 0) {
      local = local.slice(0, index);
    }
  }

  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    local = local.replaceAll('.', '');

    domain = 'gmail.com';
  }

  return `${local}@${domain}`;
}

/** The `user` columns describing its address; written only via `nextEmail`. */
export type EmailFields = {
  email: string | null;
  emailKey: string | null;
  emailVerified: boolean;
};

export const NO_EMAIL: EmailFields = {
  email: null,
  emailKey: null,
  emailVerified: false,
};

/**
 * The address fields after storing `email` (`null` clears them). A proof
 * survives only on the same mailbox; `keepExisting` stores it only where none
 * is, else just adds the proof to the same mailbox.
 */
export function nextEmail(
  current: EmailFields,
  email: string | null,
  { proven = false, keepExisting = false } = {},
): EmailFields {
  if (email === null) {
    return keepExisting ? current : NO_EMAIL;
  }

  const emailKey = normalizeEmail(email);

  const sameMailbox = current.emailKey === emailKey;

  if (keepExisting && current.email !== null) {
    return {
      ...current,
      emailVerified: current.emailVerified || (proven && sameMailbox),
    };
  }

  return {
    email,
    emailKey,
    emailVerified: proven || (sameMailbox && current.emailVerified),
  };
}

/** Whether going from `current` to `next` changes the mailbox. */
export function changesMailbox(current: EmailFields, next: EmailFields) {
  return current.emailKey !== next.emailKey;
}

/**
 * The SQL writing `next` over `current`, unpublishing the address when the
 * mailbox changes: the user published the one they had, not this one.
 */
export function emailChangeSql(
  current: EmailFields & { publicFields: string[] },
  next: EmailFields,
) {
  return changesMailbox(current, next)
    ? sql`${emailFieldsSql(next)}, publicFields = ${JSON.stringify(current.publicFields.filter((f) => f !== 'email'))}`
    : emailFieldsSql(next);
}

/** The SQL assignments writing `fields`. */
export function emailFieldsSql(fields: EmailFields) {
  return sql`email = ${fields.email}, emailKey = ${fields.emailKey}, emailVerified = ${fields.emailVerified}`;
}

/**
 * SQL storing an unproven `email` where the row has none and its owner didn't
 * remove one, for writers that don't lock the row. Order-free: `emailKey` is
 * null exactly when `email` is.
 */
export function fillEmailSql(email: string | null | undefined) {
  return sql`email = COALESCE(email, IF(emailReminderOff, NULL, ${email ?? null})),
    emailKey = COALESCE(emailKey, IF(emailReminderOff, NULL, ${email ? normalizeEmail(email) : null}))`;
}
