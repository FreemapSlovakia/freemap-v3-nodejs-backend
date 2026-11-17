import assert from 'node:assert/strict';
import test from 'node:test';

// Read when the modules load.
process.env['WEB_BASE_URL'] ??= 'https://www.freemap.sk';

const { MAIL_LANGS, mailTexts, htmlQuote } = await import(
  './notificationMail.js'
);

const { MESSAGES } = await import('./routers/gallery/commentMail.js');

// The wording goes into HTML unescaped, around escaped names and titles.
test('no email wording holds a markup character', () => {
  for (const lang of MAIL_LANGS) {
    const texts = Object.values(mailTexts(lang)).flatMap((v) =>
      typeof v === 'function'
        ? [
            (v as (...a: unknown[]) => string)('X', 'Y', true),
            (v as (...a: unknown[]) => string)('X', 'Y', false),
          ]
        : [v],
    );

    for (const own of [true, false]) {
      texts.push(MESSAGES[lang]({ name: 'X', title: 'Y ', url: 'U' }, own));
    }

    for (const text of texts) {
      assert.doesNotMatch(String(text), /[<>&]/, `${lang}: ${text}`);
    }
  }
});

test('a quoted comment is escaped and keeps its line breaks', () => {
  assert.match(htmlQuote('a <b>\r\nc & d'), />a &lt;b&gt;<br>c &amp; d</);
});
