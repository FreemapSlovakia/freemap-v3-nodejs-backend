// For a new account with no name of its own. Not the address's local part:
// the name is public, the address is not.
export const NEW_USER_NAMES: Record<string, string> = {
  en: 'Freemap user',
  sk: 'Používateľ Freemap',
  cs: 'Uživatel Freemap',
  de: 'Freemap-Nutzer',
  fr: 'Utilisateur Freemap',
  hu: 'Freemap-felhasználó',
  it: 'Utente Freemap',
  pl: 'Użytkownik Freemap',
  sl: 'Uporabnik Freemap',
};

const PLACEHOLDERS = new Set(Object.values(NEW_USER_NAMES));

/** Whether `name` is one given for want of the user's own. */
export function isPlaceholderName(name: string): boolean {
  return PLACEHOLDERS.has(name);
}
