import assert from 'node:assert/strict';
import test from 'node:test';
import { streamDumpRows } from './sqlDumpParser.js';

async function* once(s: string): AsyncGenerator<Buffer> {
  yield Buffer.from(s, 'utf8');
}

/** Yield the string one byte at a time to exercise chunk-boundary handling. */
async function* byByte(s: string): AsyncGenerator<Buffer> {
  const buf = Buffer.from(s, 'utf8');

  for (let i = 0; i < buf.length; i++) {
    yield buf.subarray(i, i + 1);
  }
}

const DUMP = `-- dump header
CREATE TABLE \`other\` (
  \`x\` int NOT NULL
);
INSERT INTO \`other\` VALUES (1),(2);
CREATE TABLE \`geo_tags\` (
  \`gt_id\` int unsigned NOT NULL AUTO_INCREMENT,
  \`gt_page_id\` int unsigned NOT NULL,
  \`gt_globe\` varbinary(32) NOT NULL,
  \`gt_type\` varbinary(32) DEFAULT NULL,
  \`gt_name\` varbinary(255) DEFAULT NULL,
  PRIMARY KEY (\`gt_id\`)
);
INSERT INTO \`geo_tags\` VALUES (1,100,'earth','camera',NULL),(2,200,'earth','camera','O\\'Brien, place'),(3,300,'earth','landmark','x');
`;

test('parses target-table rows with column names, ignoring other tables', async () => {
  const rows = [];

  for await (const row of streamDumpRows(once(DUMP), 'geo_tags')) {
    rows.push(row);
  }

  assert.equal(rows.length, 3);

  assert.deepEqual(rows[0].columns, [
    'gt_id',
    'gt_page_id',
    'gt_globe',
    'gt_type',
    'gt_name',
  ]);

  assert.deepEqual(rows[0].values, [1, 100, 'earth', 'camera', null]);

  // Escaped quote and a comma inside a string literal.
  assert.deepEqual(rows[1].values, [
    2,
    200,
    'earth',
    'camera',
    "O'Brien, place",
  ]);

  assert.deepEqual(rows[2].values, [3, 300, 'earth', 'landmark', 'x']);
});

test('is robust to arbitrary chunk boundaries', async () => {
  const rows = [];

  for await (const row of streamDumpRows(byByte(DUMP), 'geo_tags')) {
    rows.push(row);
  }

  assert.equal(rows.length, 3);
  assert.deepEqual(rows[1].values, [
    2,
    200,
    'earth',
    'camera',
    "O'Brien, place",
  ]);
});

test('maxFields stops early and skips the rest of each tuple', async () => {
  const rows = [];

  // Only need gt_id, gt_page_id, gt_globe (3 fields); the trailing
  // "O'Brien, place" string (with a comma + escaped quote) must be skipped.
  for await (const row of streamDumpRows(byByte(DUMP), 'geo_tags', {
    maxFields: 3,
  })) {
    rows.push(row);
  }

  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0].values, [1, 100, 'earth']);
  assert.deepEqual(rows[1].values, [2, 200, 'earth']);
  assert.deepEqual(rows[2].values, [3, 300, 'earth']);
});
