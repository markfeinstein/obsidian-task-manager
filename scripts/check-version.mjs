#!/usr/bin/env node
import process from 'node:process';
import { validateReleaseMetadata } from './package-helpers.mjs';

const errors = validateReleaseMetadata(process.cwd());

if (errors.length > 0) {
  console.error('Version consistency check failed:');
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log('Version consistency check passed.');
