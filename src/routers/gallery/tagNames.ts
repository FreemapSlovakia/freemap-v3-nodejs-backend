/** The tag hiding a picture from all but its author and moderators. */
export const PRIVATE_TAG = 'private';

/** tagLabel's language of a taxon's Latin name; not a UI language. */
export const LATIN = 'la';

/**
 * A tag name or label as stored: one line, as a picture's names are joined by
 * newlines, cut by code points (no surrogate pair split) to the column's 255.
 */
export function oneLine(s: string): string {
  return [...s.replace(/\s+/g, ' ').trim()].slice(0, 255).join('');
}
