// Run by remote-deploy.sh before the build, and by the harvest before its PR:
// the API serves what it can of a broken catalog rather than fail, so a broken
// one must not get that far.
import { readFileSync } from 'node:fs';
import { entryProblems, fileProblems } from '../src/catalogRules.mjs';

// Far below the harvest's size, far above a truncated file's.
const MIN_HARVESTED = 500;

const problems = [];

const read = (file) => {
  const json = JSON.parse(
    readFileSync(new URL(`../mapCatalog/${file}`, import.meta.url), 'utf8'),
  );

  for (const problem of fileProblems(json)) {
    problems.push(`${file}: ${problem}`);
  }

  return Array.isArray(json?.maps) ? json.maps : [];
};

const curated = read('curated/curatedCatalog.json');

const eli = read('eli/eliCatalog.json');

if (!curated.length) {
  problems.push('curatedCatalog.json has no maps');
}

if (eli.length < MIN_HARVESTED) {
  problems.push(
    `eliCatalog.json has ${eli.length} maps, fewer than ${MIN_HARVESTED}`,
  );
}

// A curated map must not take an id the harvest gave out, live or retired:
// users who installed that map would silently get this one.
const { ids = {}, retired = {} } = JSON.parse(
  readFileSync(new URL('../mapCatalog/eli/ids.json', import.meta.url), 'utf8'),
);

const harvestIds = new Set([...Object.values(ids), ...Object.values(retired)]);

for (const map of curated) {
  if (harvestIds.has(map?.type)) {
    problems.push(`curated ${map.type}: an id the harvest gave out`);
  }
}

// A harvested map's id must be the table's live one, or the next harvest may
// give it to another map.
const liveIds = new Set(Object.values(ids));

for (const map of eli) {
  if (!liveIds.has(map?.type)) {
    problems.push(`harvested ${map?.type}: not a live id of ids.json`);
  }
}

const seen = new Set();

for (const map of [...curated, ...eli]) {
  const type = map?.type;

  if (seen.has(type)) {
    // A curated id the harvest also gave out lands here too.
    problems.push(`id ${type} used twice`);
  }

  seen.add(type);

  for (const problem of entryProblems(map)) {
    problems.push(`${JSON.stringify(type)}: ${problem}`);
  }
}

if (problems.length) {
  console.error(problems.slice(0, 50).join('\n'));

  process.exit(1);
}

console.log(`Map catalog: ${curated.length} curated, ${eli.length} harvested.`);
