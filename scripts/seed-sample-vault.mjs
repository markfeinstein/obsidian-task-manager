#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export const SAMPLE_DATE_ANCHOR = '2026-05-26';

function isoDay(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) throw new Error(`Invalid ISO date: ${value}`);
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new Error(`Invalid ISO date: ${value}`);
  return date;
}

function shiftIsoDate(value, dayDelta) {
  const date = isoDay(value);
  date.setUTCDate(date.getUTCDate() + dayDelta);
  return date.toISOString().slice(0, 10);
}

function markdownFiles(directory) {
  const files = [];
  for (const name of readdirSync(directory).sort()) {
    const absolute = path.join(directory, name);
    if (statSync(absolute).isDirectory()) files.push(...markdownFiles(absolute));
    else if (name.endsWith('.md')) files.push(absolute);
  }
  return files;
}

export function seedSampleVault({
  source = path.resolve('sample-vault'),
  output,
  date,
}) {
  if (!output) throw new Error('An output directory is required; tracked regression fixtures are never rewritten in place.');
  const targetDate = isoDay(date).toISOString().slice(0, 10);
  const sourceRoot = path.resolve(source);
  const outputRoot = path.resolve(output);
  if (sourceRoot === outputRoot || outputRoot.startsWith(`${sourceRoot}${path.sep}`)) throw new Error('Output must be outside the tracked sample-vault directory.');
  const dayDelta = Math.round((isoDay(targetDate).getTime() - isoDay(SAMPLE_DATE_ANCHOR).getTime()) / 86_400_000);
  rmSync(outputRoot, { recursive: true, force: true });
  mkdirSync(path.dirname(outputRoot), { recursive: true });
  cpSync(sourceRoot, outputRoot, { recursive: true });
  for (const file of markdownFiles(outputRoot)) {
    const content = readFileSync(file, 'utf8').replace(/\b\d{4}-\d{2}-\d{2}\b/gu, (match) => {
      try { return shiftIsoDate(match, dayDelta); } catch { return match; }
    });
    writeFileSync(file, content);
  }
  const oldDaily = path.join(outputRoot, 'Daily', `${SAMPLE_DATE_ANCHOR}.md`);
  const newDaily = path.join(outputRoot, 'Daily', `${targetDate}.md`);
  if (existsSync(oldDaily) && oldDaily !== newDaily) renameSync(oldDaily, newDaily);
  return { sourceRoot, outputRoot, targetDate, dayDelta };
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = seedSampleVault({ date: option('--date') ?? new Date().toISOString().slice(0, 10), output: option('--output') });
  console.log(`Seeded relative-to-${result.targetDate} sample vault at ${result.outputRoot}`);
}
