#!/usr/bin/env node
import esbuild from 'esbuild';
import { readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export async function composeStyles(root = process.cwd()) {
  const sourceDir = path.join(root, 'styles');
  const files = readdirSync(sourceDir).filter((name) => name.endsWith('.css')).sort();
  if (files.length === 0) throw new Error('No CSS source partials found in styles/');
  const source = files.map((name) => readFileSync(path.join(sourceDir, name), 'utf8')).join('');
  const result = await esbuild.transform(source, { loader: 'css', minify: true, legalComments: 'none' });
  const output = result.code.endsWith('\n') ? result.code : `${result.code}\n`;
  return { files, source, output, sourceBytes: Buffer.byteLength(source), outputBytes: Buffer.byteLength(output) };
}

export async function buildStyles(root = process.cwd(), outputPath = path.join(root, 'styles.css')) {
  const result = await composeStyles(root);
  const temporary = path.join(path.dirname(outputPath), `.${path.basename(outputPath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    writeFileSync(temporary, result.output);
    renameSync(temporary, outputPath);
  } finally {
    rmSync(temporary, { force: true });
  }
  return { files: result.files, sourceBytes: result.sourceBytes, outputBytes: result.outputBytes };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = await buildStyles();
  console.log(`Built styles.css from ${result.files.length} partials (${result.sourceBytes} -> ${result.outputBytes} bytes).`);
}
