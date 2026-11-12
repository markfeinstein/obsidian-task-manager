#!/usr/bin/env node
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { evaluateChangedCoverage } from './changed-coverage.mjs';

const root = process.cwd();
const testRunsRoot = path.join(root, '.test-runs');

class RunnerError extends Error {
  constructor(message, status = 2) {
    super(message);
    this.status = status;
  }
}

function fail(message) {
  throw new RunnerError(`Test runner: ${message}`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', ...options });
  if (result.status !== 0) throw new RunnerError('', result.status ?? 1);
}

function atomicWrite(file, content) {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(temporary, content);
  renameSync(temporary, file);
}

let coverage = false;
let buildOnly = false;
let namePattern;
const selections = [];
const passthrough = [];
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === '--coverage') coverage = true;
  else if (arg === '--build-only') buildOnly = true;
  else if (arg === '--grep' || arg === '--test-name-pattern') {
    namePattern = args[++index];
    if (!namePattern) fail(`${arg} requires a pattern`);
  } else if (arg.startsWith('--test-name-pattern=')) namePattern = arg.slice(arg.indexOf('=') + 1);
  else if (arg.startsWith('--')) passthrough.push(arg);
  else selections.push(arg);
}

const configuredTestDist = process.env.TASK_MANAGER_TEST_DIST;
const runInfoPath = process.env.TASK_MANAGER_TEST_RUN_INFO
  ? path.resolve(root, process.env.TASK_MANAGER_TEST_RUN_INFO)
  : undefined;
const ownsTestDist = !configuredTestDist && !buildOnly;
if (ownsTestDist) mkdirSync(testRunsRoot, { recursive: true });
const testDist = configuredTestDist
  ? path.resolve(root, configuredTestDist)
  : buildOnly
    ? path.join(root, '.test-dist')
    : mkdtempSync(path.join(testRunsRoot, 'test-'));

let cleaned = false;
function cleanupTestDist() {
  if (!ownsTestDist || cleaned) return;
  cleaned = true;
  rmSync(testDist, { recursive: true, force: true });
  try { rmdirSync(testRunsRoot); } catch { /* another test run still owns the directory */ }
}
process.once('exit', cleanupTestDist);

function buildTests() {
  rmSync(testDist, { recursive: true, force: true });
  const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
  if (!existsSync(tsc)) fail('node_modules is missing; run npm ci first');
  run(process.execPath, [tsc, '-p', 'tsconfig.test.json', '--outDir', testDist]);
  const mockDir = path.join(testDist, 'node_modules', 'obsidian');
  mkdirSync(mockDir, { recursive: true });
  copyFileSync(path.join(root, 'tests', 'obsidian-mock.js'), path.join(mockDir, 'index.js'));
}

function discoverTests(directory, suffix) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...discoverTests(absolute, suffix));
    else if (entry.isFile() && entry.name.endsWith(suffix)) files.push(absolute);
  }
  return files;
}

function allTests() {
  const compiled = discoverTests(path.join(testDist, 'tests'), '.test.js');
  const native = discoverTests(path.join(root, 'tests'), '.test.mjs');
  return [...compiled, ...native];
}

function selectedTest(raw) {
  const normalized = raw.replaceAll('\\', '/').replace(/^\.\//u, '');
  if (normalized.split('/').includes('..')) fail(`test path may not traverse outside tests/: ${raw}`);
  if (normalized.endsWith('.ts')) {
    if (!normalized.startsWith('tests/')) fail(`TypeScript test must be under tests/: ${raw}`);
    return path.join(testDist, normalized.replace(/\.ts$/u, '.js'));
  }
  if (normalized.endsWith('.mjs')) {
    if (!normalized.startsWith('tests/')) fail(`module test must be under tests/: ${raw}`);
    return path.join(root, normalized);
  }
  if (normalized.endsWith('.js')) {
    const compatibilityPath = normalized.replace(/^\.test-dist\//u, '');
    return path.join(testDist, compatibilityPath);
  }
  const candidate = path.join(testDist, 'tests', `${normalized.replace(/^tests\//u, '')}.test.js`);
  if (existsSync(candidate)) return candidate;
  fail(`Unsupported test selection: ${raw}`);
}

let publishedCoverageDir;

async function main() {
  buildTests();
  if (buildOnly) return 0;
  const files = selections.length > 0 ? selections.map(selectedTest) : allTests();
  for (const file of files) {
    if (!existsSync(file)) fail(`selected test does not exist after compilation: ${path.relative(root, file)}`);
  }

  const nodeArgs = ['--test'];
  if (namePattern) nodeArgs.push(`--test-name-pattern=${namePattern}`);
  nodeArgs.push(...passthrough);
  const coverageBaseline = coverage
    ? JSON.parse(readFileSync(path.join(root, 'quality', 'coverage-baseline.json'), 'utf8'))
    : null;
  if (coverageBaseline) {
    const coverageRoot = testDist.replaceAll('\\', '/');
    nodeArgs.push(
      '--experimental-test-coverage',
      `--test-coverage-include=${coverageRoot}/src/**/*.js`,
      `--test-coverage-exclude=${coverageRoot}/tests/**`,
      `--test-coverage-lines=${coverageBaseline.global.lines}`,
      `--test-coverage-branches=${coverageBaseline.global.branches}`,
      `--test-coverage-functions=${coverageBaseline.global.functions}`,
    );
  }
  nodeArgs.push(...files);

  const dependencyPath = path.join(root, 'node_modules');
  const childEnv = {
    ...process.env,
    TASK_MANAGER_TEST_DIST: testDist,
    NODE_PATH: [dependencyPath, process.env.NODE_PATH].filter(Boolean).join(path.delimiter),
  };
  // A test may intentionally invoke this runner to verify isolation. Do not let
  // Node treat the nested child as part of the parent's internal test context.
  delete childEnv.NODE_TEST_CONTEXT;
  delete childEnv.NODE_TEST_WORKER_ID;
  if (!coverage) {
    run(process.execPath, nodeArgs, { env: childEnv });
    return 0;
  }

  const coverageDir = process.env.TASK_MANAGER_TEST_COVERAGE_DIR
    ? path.resolve(root, process.env.TASK_MANAGER_TEST_COVERAGE_DIR)
    : path.join(root, 'coverage');
  publishedCoverageDir = coverageDir;
  const v8Scratch = mkdtempSync(path.join(tmpdir(), 'task-manager-coverage-v8-'));
  try {
    mkdirSync(coverageDir, { recursive: true });
    const result = spawnSync(process.execPath, nodeArgs, {
      cwd: root,
      encoding: 'utf8',
      env: { ...childEnv, NODE_V8_COVERAGE: v8Scratch },
      maxBuffer: 100 * 1024 * 1024,
    });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    // Each publication is an atomic replacement. Concurrent runs targeting the
    // same output directory therefore have complete, last-writer-wins files.
    atomicWrite(path.join(coverageDir, 'test-coverage.txt'), output);
    process.stdout.write(result.stdout ?? '');
    process.stderr.write(result.stderr ?? '');
    const globalMatch = output.match(/all files\s+\|\s+([\d.]+)\s+\|\s+([\d.]+)\s+\|\s+([\d.]+)/u);
    const moduleCoverage = {};
    for (const moduleName of Object.keys(coverageBaseline.moduleFloors)) {
      const escaped = moduleName.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
      const match = output.match(new RegExp(`${escaped}\\s+\\|\\s+([\\d.]+)\\s+\\|\\s+([\\d.]+)\\s+\\|\\s+([\\d.]+)`, 'u'));
      if (match) moduleCoverage[moduleName] = { lines: Number(match[1]), branches: Number(match[2]), functions: Number(match[3]) };
    }
    atomicWrite(path.join(coverageDir, 'summary.json'), `${JSON.stringify({
      thresholds: coverageBaseline,
      actual: globalMatch ? { lines: Number(globalMatch[1]), branches: Number(globalMatch[2]), functions: Number(globalMatch[3]) } : null,
      modules: moduleCoverage,
    }, null, 2)}\n`);
    if (result.status !== 0) return result.status ?? 1;

    let moduleFailure = false;
    for (const [moduleName, minimums] of Object.entries(coverageBaseline.moduleFloors)) {
      const actuals = moduleCoverage[moduleName];
      if (!actuals) {
        console.error(`Coverage gate: ${moduleName} was not present in the report.`);
        moduleFailure = true;
        continue;
      }
      for (const metric of ['lines', 'branches', 'functions']) {
        const minimum = minimums[metric];
        const actual = actuals[metric];
        if (typeof minimum === 'number' && actual < minimum) {
          console.error(`Coverage gate: ${moduleName} ${metric} coverage ${actual}% is below ${minimum}%.`);
          moduleFailure = true;
        }
      }
    }
    const changedCoverage = evaluateChangedCoverage({
      root,
      testDist,
      rawCoverageDir: v8Scratch,
      baseRef: process.env.COVERAGE_BASE_REF,
      policy: coverageBaseline.changedLines,
    });
    atomicWrite(path.join(coverageDir, 'changed-lines.json'), `${JSON.stringify(changedCoverage, null, 2)}\n`);
    console.log(`Changed-line coverage: ${changedCoverage.coveredChangedLines}/${changedCoverage.executableChangedLines} (${changedCoverage.percent}%, aggregate minimum ${changedCoverage.minimumPercent}%; per-file minimum ${changedCoverage.perFileMinimumPercent}%).`);
    if (!changedCoverage.passed) {
      for (const file of changedCoverage.failedFiles) console.error(`Coverage gate: ${file}: ${changedCoverage.files[file].reasons.join('; ')}.`);
      console.error('Coverage gate: changed executable lines are below the reviewed minimum. See coverage/changed-lines.json.');
    }
    return moduleFailure || !changedCoverage.passed ? 1 : 0;
  } finally {
    rmSync(v8Scratch, { recursive: true, force: true });
  }
}

try {
  process.exitCode = await main();
} catch (error) {
  if (error.message) console.error(error.message);
  process.exitCode = error instanceof RunnerError ? error.status : 1;
} finally {
  cleanupTestDist();
  if (runInfoPath) {
    mkdirSync(path.dirname(runInfoPath), { recursive: true });
    atomicWrite(runInfoPath, `${JSON.stringify({
      testDist,
      ownsTestDist,
      buildOnly,
      coverage,
      coverageDir: publishedCoverageDir,
      cleaned: !existsSync(testDist),
      status: process.exitCode ?? 0,
    }, null, 2)}\n`);
  }
}
