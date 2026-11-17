import assert from 'node:assert/strict';
import test from 'node:test';
import { codeHtml, emailCodeTranslations } from './emailCodeTexts.js';

// A translation dropping the code would send an HTML mail without it.
test('every language puts the code in the HTML mail once', () => {
  for (const [lang, t] of Object.entries(emailCodeTranslations)) {
    const html = codeHtml(t, '757363');

    assert.equal(html.split('757363').length - 1, 1, `${lang}: ${html}`);

    assert.doesNotMatch(html, //, `${lang}: placeholder left`);
  }
});
