import { readFile, writeFile } from 'node:fs/promises';
import process from 'node:process';

const manifests = ['package.json', 'desktop/package.json'];

function shanghaiDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).formatToParts(date);
  const value = (type) => Number(parts.find((part) => part.type === type)?.value);
  return { year: value('year'), month: value('month'), day: value('day') };
}

function validateVersion(version) {
  const match = /^(\d{4})\.(\d{1,2})\.(\d{1,2})$/.exec(version);
  if (!match) throw new Error(`Release version must use YYYY.M.D: ${version}`);
  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  if (monthText !== String(month) || dayText !== String(day)) {
    throw new Error(`npm date versions cannot contain leading zeroes: ${version}`);
  }
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (candidate.getUTCFullYear() !== year || candidate.getUTCMonth() !== month - 1 || candidate.getUTCDate() !== day) {
    throw new Error(`Release version is not a valid calendar date: ${version}`);
  }
  return `${year}.${month}.${day}`;
}

const requested = process.argv[2];
const today = shanghaiDateParts();
const version = validateVersion(requested || `${today.year}.${today.month}.${today.day}`);

for (const file of manifests) {
  const manifest = JSON.parse(await readFile(file, 'utf8'));
  manifest.version = version;
  await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

process.stdout.write(`${version}\n`);
