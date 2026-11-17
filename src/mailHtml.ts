// The HTML part of the API's emails. Anything a user wrote goes through esc.
// Translated wording is escaped whole, a placeholder in it replaced after; or,
// where its functions take ready HTML fragments, it goes in raw, and a test
// must then keep markup characters out of it.

/** Text for HTML. */
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

export const htmlLink = (href: string, text = href) =>
  `<a href="${esc(href)}">${esc(text)}</a>`;

/** A paragraph of HTML already escaped where it needs to be. */
export const htmlPara = (html: string) => `<p>${html}</p>`;

/** User-written text, its line breaks kept. */
export const htmlQuote = (text: string) =>
  `<blockquote style="margin:0;padding-left:12px;border-left:3px solid #ccc">${text
    .split(/\r?\n/)
    .map(esc)
    .join('<br>')}</blockquote>`;

/** Small grey text under a rule, for footers and fine print. */
export const htmlSmall = (html: string) =>
  `<hr style="border:0;border-top:1px solid #ddd"><p style="font-size:13px;color:#666">${html}</p>`;

/** A whole HTML mail of these blocks. */
export const htmlPage = (blocks: string[]) =>
  [
    '<!doctype html><html><body style="font-family:sans-serif;font-size:15px;line-height:1.4">',
    ...blocks,
    '</body></html>',
  ].join('\n');
