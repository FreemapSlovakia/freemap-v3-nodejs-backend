import assert from 'node:assert/strict';
import test from 'node:test';
import {
  abruptReport,
  failureReport,
  type ImportStats,
  notify,
  SELF_REPORTED_EXIT_STATUS,
  successReport,
} from './importNotify.js';

const STATS: ImportStats = {
  geoTags: 36_812_004,
  photos: 31_164_478,
  imageMeta: 30_991_233,
  sdc: 28_004_118,
  live: 31_164_478,
  previous: 31_234_601,
};

test('successReport leads with the live count and its delta', () => {
  const { subject, body } = successReport(STATS, 4 * 3600_000 + 12 * 60_000);

  assert.match(subject, /^Wikimedia import succeeded on /);
  assert.match(body, /live photos: {2}31,164,478 \(-70,123 vs\. the previous/);
  assert.match(body, /duration: {5}4h 12m/);
  assert.match(body, /camera geo tags: {2}36,812,004/);
  assert.match(body, /journalctl -u freemap-wikimedia-import\.service/);
});

test('successReport says "no change" rather than a signed zero', () => {
  const { body } = successReport({ ...STATS, previous: STATS.live }, 1000);

  assert.match(body, /\(no change vs\. the previous 31,164,478\)/);
});

test('successReport still reports when the baseline could not be counted', () => {
  const { body } = successReport({ ...STATS, previous: null }, 1000);

  assert.match(
    body,
    /live photos: {2}31,164,478 \(previous count unavailable\)/,
  );
});

test('successReport still reports when neither count could be taken', () => {
  const both = successReport({ ...STATS, live: null, previous: null }, 1000);

  assert.match(both.subject, /succeeded/);
  assert.match(both.body, /live photos: {2}not counted$/m);

  const one = successReport({ ...STATS, live: null }, 1000);

  assert.match(one.body, /not counted \(the previous was 31,234,601\)/);
});

test('failureReport carries the stack and reassures about the live table', () => {
  const err = new Error('ECONNRESET while streaming the image dump');

  const { subject, body } = failureReport(err, 63 * 60_000);

  assert.match(subject, /^Wikimedia import FAILED on /);
  assert.match(body, /after 1h 3m/);
  assert.match(body, / {2}Error: ECONNRESET while streaming the image dump/);
  assert.match(body, /The gallery is unaffected/);
});

test('failureReport survives a non-Error rejection', () => {
  const { body } = failureReport('just a string', 5000);

  assert.match(body, / {2}just a string/);
});

test('abruptReport reports the systemd monitor variables', () => {
  const { subject, body } = abruptReport({
    result: 'signal',
    exitCode: 'killed',
    exitStatus: 'KILL',
  });

  assert.match(subject, /^Wikimedia import DIED on /);
  assert.match(body, /result: signal/);
  assert.match(body, /code: {3}killed/);
  assert.match(body, /status: KILL/);
});

test('abruptReport falls back to "unknown" for absent variables', () => {
  const { body } = abruptReport({});

  assert.match(body, /result: unknown/);
});

/**
 * The exit status is the only channel telling the `OnFailure=` backstop whether
 * the admins already heard. Claiming they did when the send never happened
 * silences the backstop too, and the failure reaches nobody — so an undelivered
 * report must not report itself as delivered. Reporting is off in the test
 * environment (no `WIKIMEDIA_IMPORT_NOTIFY_EMAIL`, no `MAILGUN_ENABLE`), which
 * is exactly the undelivered case.
 */
test('notify says so when the mail did not go out', async () => {
  const reported = await notify(failureReport(new Error('boom'), 1000));

  assert.equal(reported, false);
  assert.notEqual(
    reported ? SELF_REPORTED_EXIT_STATUS : 1,
    SELF_REPORTED_EXIT_STATUS,
  );
});
