import assert from 'node:assert/strict';
import test from 'node:test';
import { fold, type IcalEvent, icalendar } from './ical.js';

const base: IcalEvent = {
  id: 'abc12345',
  title: 'Výstup na Kľak; zraz, 8:00',
  description: 'Line one\nLine two\rLine three\x07',
  startAt: new Date('2026-12-05T07:00:00Z'),
  endAt: null,
  dateOnly: false,
  startLat: 48.5,
  startLon: 19.25,
  updatedAt: new Date('2026-11-01T10:00:00Z'),
  organizer: 'KST',
  url: 'https://www.freemap.sk/#panel=event/abc12345',
};

const stamp = new Date('2026-11-25T12:00:00Z');

test('a timed event is in UTC, text escaped', () => {
  const ics = icalendar('Moje', [base], stamp);

  assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\n'));

  assert.ok(ics.endsWith('END:VCALENDAR\r\n'));

  assert.ok(ics.includes('\r\nDTSTART:20261205T070000Z\r\n'));

  assert.ok(!ics.includes('DTEND'));

  assert.ok(ics.includes('SUMMARY:Výstup na Kľak\\; zraz\\, 8:00'));

  assert.ok(ics.includes('Line one\\nLine two\\nLine three\\n\\nKST'));

  assert.ok(ics.includes('\r\nGEO:48.500000;19.250000\r\n'));
});

test("a date-only event's DTEND is the day after its last", () => {
  const ics = icalendar(
    'x',
    [
      {
        ...base,
        dateOnly: true,
        startAt: new Date('2026-12-05T00:00:00Z'),
        endAt: new Date('2026-12-06T00:00:00Z'),
      },
    ],
    stamp,
  );

  assert.ok(ics.includes('\r\nDTSTART;VALUE=DATE:20261205\r\n'));

  assert.ok(ics.includes('\r\nDTEND;VALUE=DATE:20261207\r\n'));
});

test('long lines fold at 75 octets, not inside a character', () => {
  const folded = fold(`SUMMARY:${'ľ'.repeat(100)}`);

  const lines = folded.split('\r\n');

  assert.ok(lines.length > 1);

  for (const line of lines) {
    assert.ok(Buffer.byteLength(line) <= 75);

    assert.ok(!line.includes('�'));
  }

  assert.equal(
    lines.map((l, i) => (i ? l.slice(1) : l)).join(''),
    `SUMMARY:${'ľ'.repeat(100)}`,
  );
});
