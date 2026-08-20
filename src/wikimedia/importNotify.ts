import { hostname } from 'node:os';
import { getEnv, getEnvBoolean } from '../env.js';
import { appLogger } from '../logger.js';
import { sendMail } from '../mailer.js';

const logger = appLogger.child({ module: 'wikimediaImportNotify' });

/**
 * Admin recipients of the import report, comma-separated in the environment.
 * No entries (the default) turns reporting off, so a checkout that isn't the
 * production server never mails anyone — the addresses are configured in
 * `/etc/freemap.conf` on fm6 rather than baked into this repository, which is
 * public.
 *
 * Trimmed and emptied-out rather than handed to Mailgun verbatim: the value is
 * hand-written in a config file, so `a@b.sk, c@d.sk` and a trailing comma are
 * both a matter of time, and Mailgun rejects the whole send over one malformed
 * address — costing us exactly the notification we were trying to deliver.
 */
const NOTIFY_EMAILS = getEnv('WIKIMEDIA_IMPORT_NOTIFY_EMAIL', '')
  .split(',')
  .map((email) => email.trim())
  .filter(Boolean);

/** The systemd unit, named in the mails so the reader can go read the log. */
const SERVICE_UNIT = getEnv(
  'WIKIMEDIA_IMPORT_UNIT',
  'freemap-wikimedia-import.service',
);

/**
 * Exit status the import uses when it has already mailed its own failure, so
 * the `OnFailure=` backstop can distinguish that from a death it must report
 * itself. Any other nonzero status means nobody has told the admins yet.
 */
export const SELF_REPORTED_EXIT_STATUS = 2;

/** Row counts a finished run has to show for itself. */
export type ImportStats = {
  /** Camera-type geo tags staged from the geo_tags dump. */
  geoTags: number;
  /** Of those, the ones whose title passed `isPhotoTitle`. */
  photos: number;
  /** Kept photos the image dump had EXIF metadata for. */
  imageMeta: number;
  /** Kept photos Structured Data on Commons had a statement for. */
  sdc: number;
  /**
   * Rows the swap published. `null` when the count could not be taken — it is
   * only a statistic, and is never allowed to fail an import over it.
   */
  live: number | null;
  /** Rows that were live before it — 0 on the very first run, `null` as above. */
  previous: number | null;
};

const NUM = new Intl.NumberFormat('en-US');

function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);

  return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${total % 60}s` : `${total}s`;
}

/**
 * The live-count line: `31,164,478 (-70,123 vs. the previous 31,234,601)`, or
 * the bare count when the baseline could not be read.
 */
function formatLive(live: number | null, previous: number | null): string {
  if (live === null) {
    return previous === null
      ? 'not counted'
      : `not counted (the previous was ${NUM.format(previous)})`;
  }

  if (previous === null) {
    return `${NUM.format(live)} (previous count unavailable)`;
  }

  const delta = live - previous;

  const change =
    delta === 0
      ? 'no change'
      : `${delta > 0 ? '+' : '-'}${NUM.format(Math.abs(delta))}`;

  return `${NUM.format(live)} (${change} vs. the previous ${NUM.format(previous)})`;
}

/**
 * How long to wait on Mailgun before giving up on the report and getting on
 * with exiting.
 */
const SEND_DEADLINE_MS = 30_000;

/**
 * Mails the admins. Never throws and always settles: a run that worked must not
 * be reported as failed because Mailgun had a bad minute, and a run that failed
 * has already logged the reason that matters.
 *
 * Returns whether a mail actually reached Mailgun. The caller needs the
 * difference — an undelivered report is indistinguishable from no failure at
 * all, so the exit status has to say which happened rather than merely that we
 * meant to. A deliberately disabled reporter counts as undelivered too: the
 * escalation it triggers can do no worse than the same silence.
 */
export async function notify({ subject, body }: Report): Promise<boolean> {
  if (NOTIFY_EMAILS.length === 0) {
    logger.warn(
      'WIKIMEDIA_IMPORT_NOTIFY_EMAIL is unset — not mailing the import report',
    );

    return false;
  }

  if (!getEnvBoolean('MAILGUN_ENABLE', false)) {
    logger.warn('MAILGUN_ENABLE is off — not mailing the import report');

    return false;
  }

  const to = NOTIFY_EMAILS.join(',');

  try {
    // Mailgun splits a comma-separated `to` itself, so the admins get one
    // message between them rather than one send each. Bounded, because this is
    // awaited on the way to `process.exit`: a black-holed connection would
    // otherwise leave the importer in `activating` until systemd's start
    // timeout killed it hours later, and the backstop would then mail "DIED"
    // in place of the real reason.
    await sendMail(to, subject, body, SEND_DEADLINE_MS);

    logger.info(`Mailed the import report to ${to}`);

    return true;
  } catch (err) {
    logger.error({ err }, 'Could not mail the import report');

    return false;
  }
}

/** Subject and body of a mail, so the wording can be exercised without sending. */
export type Report = { subject: string; body: string };

/** Closing line of every report, so the three bodies can't drift apart. */
const LOG_FOOTER = `Check the log for details:
  journalctl -u ${SERVICE_UNIT}
`;

export function successReport(stats: ImportStats, durationMs: number): Report {
  return {
    subject: `Wikimedia import succeeded on ${hostname()}`,
    body: `The Wikimedia Commons photo import finished successfully on ${hostname()}
at ${new Date().toString()}.

  live photos:  ${formatLive(stats.live, stats.previous)}
  duration:     ${formatDuration(durationMs)}

Staged along the way:

  camera geo tags:  ${NUM.format(stats.geoTags)}
  kept as photos:   ${NUM.format(stats.photos)}
  image metadata:   ${NUM.format(stats.imageMeta)}
  structured data:  ${NUM.format(stats.sdc)}

A large drop in "kept as photos" without a matching drop in "camera geo tags"
means the title filters started rejecting more — check them before assuming
Commons lost the files.

${LOG_FOOTER}`,
  };
}

export function failureReport(err: unknown, durationMs: number): Report {
  const message =
    err instanceof Error ? (err.stack ?? err.message) : String(err);

  return {
    subject: `Wikimedia import FAILED on ${hostname()}`,
    body: `The Wikimedia Commons photo import FAILED on ${hostname()}
at ${new Date().toString()}, after ${formatDuration(durationMs)}.

${message
  .split('\n')
  .map((line) => `  ${line}`)
  .join('\n')}

The gallery is unaffected: the new table is only swapped in at the very last
step, so a run that dies before that leaves the live wikimediaPicture table
serving the previous month's data. The schedule is untouched and the next run
will start over.

${LOG_FOOTER}`,
  };
}

/**
 * The `$MONITOR_*` variables systemd sets on an `OnFailure=` unit, taken as an
 * argument rather than read from `process.env` so the wording is testable.
 */
export type MonitorEnv = {
  result?: string | undefined;
  exitCode?: string | undefined;
  exitStatus?: string | undefined;
};

export function abruptReport(monitor: MonitorEnv): Report {
  return {
    subject: `Wikimedia import DIED on ${hostname()}`,
    body: `The Wikimedia Commons photo import terminated without reporting a result
on ${hostname()} at ${new Date().toString()}.

  result: ${monitor.result ?? 'unknown'}
  code:   ${monitor.exitCode ?? 'unknown'}
  status: ${monitor.exitStatus ?? 'unknown'}

An out-of-memory kill is the usual cause — the import holds ~200 MB of bit sets
on top of the node heap while streaming the dumps.

The gallery is almost certainly unaffected: the new table is swapped in at the
very last step, so a death anywhere before it leaves the live wikimediaPicture
table serving the previous month's data. This mail cannot promise that outright
— it is sent by a separate unit that only sees how the import died, not how far
it got — and there is a short window after the swap where the run is still
mailing and tidying up. The log below says which side of it this was: look for
"Wikimedia import done".

The schedule is untouched, so the next monthly run will start over — and it
drops and rebuilds the wm_* staging tables the dead run left behind.

${LOG_FOOTER}`,
  };
}

/**
 * Backstop for a run that died without getting to report — OOM kill, SIGKILL,
 * watchdog, a start timeout, or a crash before the import's own error handling
 * was even reachable. Driven by systemd's `$MONITOR_*` variables and wired up
 * as `OnFailure=` on the import unit. Mirrors `notify.sh --abrupt` in the
 * GraphHopper/Photon scripts.
 */
export async function reportAbrupt(): Promise<void> {
  const monitor: MonitorEnv = {
    result: process.env['MONITOR_SERVICE_RESULT'],
    exitCode: process.env['MONITOR_EXIT_CODE'],
    exitStatus: process.env['MONITOR_EXIT_STATUS'],
  };

  // A run that mailed its own reason exits with SELF_REPORTED_EXIT_STATUS
  // specifically so this one case can be told apart. Suppressing on
  // `result === 'exit-code'` instead would swallow every failure that never
  // reached that handler — a 203/EXEC because the node path moved, a throw
  // while loading config, an unhandled rejection — all of which exit nonzero
  // under their own steam and would then be reported by nobody at all.
  if (monitor.exitStatus === String(SELF_REPORTED_EXIT_STATUS)) {
    logger.info(`${SERVICE_UNIT} reported for itself; staying quiet`);

    return;
  }

  await notify(abruptReport(monitor));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv[2] !== '--abrupt') {
    console.error(`usage: ${process.argv[1]} --abrupt`);

    process.exit(1);
  }

  reportAbrupt()
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error(err);

      process.exit(1);
    });
}
