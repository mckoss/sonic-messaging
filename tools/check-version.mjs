import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const current = JSON.parse(readFileSync('package.json', 'utf8')).version;
const base = process.env.VERSION_BASE_SHA || process.argv[2] || 'HEAD^';

function parse(version) {
  const match = semverPattern.exec(version);
  if (!match) throw new Error(`Invalid semantic version: ${version}`);
  return { numbers: match.slice(1, 4).map(Number), prerelease: match[4] };
}

function compare(left, right) {
  for (let index = 0; index < 3; index++) {
    if (left.numbers[index] !== right.numbers[index]) return left.numbers[index] - right.numbers[index];
  }
  if (!left.prerelease && right.prerelease) return 1;
  if (left.prerelease && !right.prerelease) return -1;
  return String(left.prerelease ?? '').localeCompare(String(right.prerelease ?? ''), undefined, { numeric: true });
}

const currentParsed = parse(current);
let previous;
try {
  previous = JSON.parse(execFileSync('git', ['show', `${base}:package.json`], { encoding: 'utf8' })).version;
} catch {
  console.log(`No prior package.json at ${base}; accepted initial version ${current}.`);
  process.exit(0);
}

if (compare(currentParsed, parse(previous)) <= 0) {
  throw new Error(`Version must increase on main: ${previous} → ${current}`);
}
console.log(`Version increased: ${previous} → ${current}`);
