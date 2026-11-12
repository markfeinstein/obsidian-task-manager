#!/usr/bin/env node
import { mkdirSync, mkdtempSync, readFileSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { performance } from 'node:perf_hooks';
import os from 'node:os';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { computeSourceIdentity, sourceRevision } from './source-identity.mjs';

const root = process.cwd();
const baseline = JSON.parse(readFileSync(path.join(root, 'quality', 'performance-baseline.json'), 'utf8'));
const fullProfile = process.argv.includes('--full');
// Structural mode is used only by test-runner isolation regressions. It still
// exercises production workloads and exact counters, but does not interpret
// co-scheduled/coverage-instrumented wall time or memory as benchmark evidence.
const structuralOnly = process.argv.includes('--structural-only');
const measuredSamples = fullProfile ? Math.max(20, baseline.samples) : baseline.samples;

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

function percentile95(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)];
}

async function sample(name, operation) {
  await operation();
  globalThis.gc?.();
  const durations = [];
  const heapDeltas = [];
  const rssBaselineBytes = process.memoryUsage().rss;
  let peakRssBytes = rssBaselineBytes;
  let value;
  for (let index = 0; index < measuredSamples; index += 1) {
    globalThis.gc?.();
    const memoryProbe = index === 0;
    const heapBefore = process.memoryUsage().heapUsed;
    let heapPeak = heapBefore;
    const sampler = memoryProbe ? setInterval(() => {
      const memory = process.memoryUsage();
      heapPeak = Math.max(heapPeak, memory.heapUsed);
      peakRssBytes = Math.max(peakRssBytes, memory.rss);
    }, 1) : undefined;
    const start = performance.now();
    value = await operation();
    const memory = process.memoryUsage();
    if (sampler) clearInterval(sampler);
    durations.push(performance.now() - start);
    if (memoryProbe) {
      heapPeak = Math.max(heapPeak, memory.heapUsed);
      peakRssBytes = Math.max(peakRssBytes, memory.rss);
      heapDeltas.push(Math.max(0, heapPeak - heapBefore));
    }
  }
  const peakHeapDeltaBytes = Math.max(...heapDeltas);
  return {
    name,
    medianMs: median(durations),
    p95Ms: percentile95(durations),
    minMs: Math.min(...durations),
    maxMs: Math.max(...durations),
    heapDeltaBytes: peakHeapDeltaBytes,
    peakHeapDeltaBytes,
    rssBaselineBytes,
    peakRssBytes,
    rssDeltaBytes: Math.max(0, peakRssBytes - rssBaselineBytes),
    memoryIsolation: 'shared-process',
    runtime: { node: process.version, platform: process.platform, arch: process.arch, cpus: os.cpus().length },
    samples: durations,
    counters: value && typeof value === 'object' && 'counters' in value ? value.counters : undefined,
    value,
  };
}

async function main() {
  const testRunsRoot = path.join(root, '.test-runs');
  mkdirSync(testRunsRoot, { recursive: true });
  const testDist = mkdtempSync(path.join(testRunsRoot, 'benchmark-'));
  try {
    const build = spawnSync(process.execPath, ['scripts/run-tests.mjs', '--build-only'], {
      cwd: root,
      stdio: 'inherit',
      env: { ...process.env, TASK_MANAGER_TEST_DIST: testDist },
    });
    if (build.status !== 0) return build.status ?? 1;

    const require = createRequire(path.join(testDist, 'benchmark-loader.cjs'));
    const { generateLargeVault } = require('./tests/fixtures/vault-large/generate-large-vault.js');
    const { TaskScanner } = require('./src/task-scanner.js');
    const { filterTasks } = require('./src/task-query.js');
    const { buildSidebarHierarchyStats, SIDEBAR_LIST_PAGE_SIZE, TaskPanelView } = require('./src/sidebar-view.js');
    const { dashboardRevisionShouldRefresh, dashboardTodayModel } = require('./src/dashboard.js');
    const { TaskQueryRenderer } = require('./src/query-renderer.js');
    const { DEFAULT_SETTINGS } = require('./src/types.js');
    const { FakeDOMElement, FakeDOMTextNode } = require('./tests/test-utils.js');
    const { TFile } = require('obsidian');

    const generated = await sample('generate', () => Promise.resolve(generateLargeVault(baseline.taskCount)));
    generated.counters = { requestedRootTasks: baseline.taskCount };
    const markdown = generated.value;
    const file = new TFile('Large.md');
    file.path = 'Large.md';
    file.name = 'Large.md';
    file.basename = 'Large';
    file.extension = 'md';
    let singleReads = 0;
    let singleBytes = 0;
    const app = { vault: { read: async () => { singleReads += 1; singleBytes += Buffer.byteLength(markdown); return markdown; } } };
    const scanner = new TaskScanner(app);
    const scanned = await sample('scan', () => { singleReads = 0; singleBytes = 0; return scanner.scanFile(file); });
    scanned.counters = { bodyReads: singleReads, bytesRead: singleBytes, parseCalls: 1 };
    const tasks = scanned.value;
    if (tasks.length !== baseline.taskCount) {
      console.error(`Benchmark fixture produced ${tasks.length} tasks; expected exactly ${baseline.taskCount}.`);
      return 1;
    }
    const queried = await sample('query', () => Promise.resolve(filterTasks(tasks, 'not done\nsort by smart\nlimit 1000')));
    queried.counters = { inputTasks: tasks.length, resultTasks: queried.value.length };
    if (queried.value.length === 0) {
      console.error('Benchmark query unexpectedly returned no tasks.');
      return 1;
    }

    const runDependencyQueryMetric = async (name, inputTasks, shape) => {
      const counters = { dependencyInspections: 0, fullArrayBlockerPredicateVisits: 0 };
      const instrumentDependencies = (ids) => new Proxy(ids, {
        get(target, property, receiver) {
          if (typeof property === 'string' && /^\d+$/u.test(property)) counters.dependencyInspections += 1;
          return Reflect.get(target, property, receiver);
        },
      });
      const width = String(inputTasks).length;
      const shapedTasks = Array.from({ length: inputTasks }, (_value, index) => {
        let id = `bench-${index}`;
        if (shape === 'hub' && index >= inputTasks - 2) id = 'duplicate-partition';
        const dependsOn = shape === 'sparse'
          ? (index === 0 ? [] : [`bench-${index - 1}`])
          : shape === 'hub'
            ? (index === 0 ? [] : ['bench-0'])
            : [];
        const source = tasks[index % tasks.length];
        return {
          ...source,
          key: `benchmark:${index}`,
          stableKey: `id:${id}`,
          filePath: `Benchmark/${String(index).padStart(width, '0')}.md`,
          lineNumber: 1,
          rawLine: `- [ ] Benchmark task ${index} 🆔 ${id}`,
          body: `Benchmark task ${index}`,
          normalizedText: `Benchmark task ${index}`,
          status: 'todo',
          checkbox: ' ',
          metadata: {
            ...source.metadata,
            id,
            dependsOn: instrumentDependencies(dependsOn),
            dates: {},
            priority: 'normal',
          },
        };
      });
      const nativeSome = Array.prototype.some;
      shapedTasks.some = function (predicate, thisArg) {
        return nativeSome.call(this, (value, index, array) => {
          counters.fullArrayBlockerPredicateVisits += 1;
          return predicate.call(thisArg, value, index, array);
        });
      };
      const dependencyEdges = shape === 'none' ? 0 : inputTasks - 1;
      const duplicateIdRecords = shape === 'hub' ? 2 : 0;
      return sample(name, () => {
        counters.dependencyInspections = 0;
        counters.fullArrayBlockerPredicateVisits = 0;
        const result = filterTasks(shapedTasks, `not done\nlimit 1000`, { today: '2026-07-12' });
        return Promise.resolve({ counters: {
          inputTasks,
          explicitIdRecords: inputTasks,
          duplicateIdRecords,
          dependencyEdges,
          resultTasks: result.length,
          dependencyInspections: counters.dependencyInspections,
          fullArrayBlockerPredicateVisits: counters.fullArrayBlockerPredicateVisits,
        } });
      });
    };
    const queryUrgencyIds = await runDependencyQueryMetric('query_urgency_ids_1000', 1_000, 'none');
    const queryUrgencySparse = await runDependencyQueryMetric('query_urgency_sparse_10000', 10_000, 'sparse');
    const queryUrgencyHub = await runDependencyQueryMetric('query_urgency_hub_50000', 50_000, 'hub');

    const sidebarHierarchy = await sample('sidebar_hierarchy', () => {
      const stats = buildSidebarHierarchyStats(tasks);
      return Promise.resolve({ counters: { inputTasks: tasks.length, hierarchyEntries: stats.size, mountedRowLimit: SIDEBAR_LIST_PAGE_SIZE } });
    });
    const countDomNodes = (node) => 1 + (node.children ?? []).reduce((sum, child) => sum + (child && typeof child === 'object' && 'children' in child ? countDomNodes(child) : 1), 0);
    const sidebarDom = await sample('sidebar_dom', () => {
      const view = new TaskPanelView({}, () => ({ ...DEFAULT_SETTINGS, enableMobileGestures: false }), scanner, () => undefined);
      view.tasks = tasks;
      view.activeTab = 'all';
      view.viewMode = 'list';
      view.searchQuery = '';
      view.listPage = 0;
      const rootElement = new FakeDOMElement('div');
      view.renderTaskList(rootElement);
      return Promise.resolve({ counters: { inputTasks: tasks.length, mountedRows: rootElement.querySelectorAll('.task-manager-panel-row').length, domNodes: countDomNodes(rootElement) } });
    });
    const queryApp = {
      vault: { getMarkdownFiles: () => [], getAbstractFileByPath: () => null },
      metadataCache: { getFileCache: () => null, fileToLinktext: () => '' },
      workspace: { getLeaf: () => ({ openFile: async () => undefined }), openLinkText: async () => undefined },
    };
    const queryRenderer = new TaskQueryRenderer(
      queryApp,
      scanner,
      () => ({ ...DEFAULT_SETTINGS, enableMobileGestures: false }),
      undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      async () => tasks,
    );
    const originalDocument = globalThis.document;
    globalThis.document = {
      createElement: (tagName) => new FakeDOMElement(tagName),
      createTextNode: (text) => new FakeDOMTextNode(text),
      createElementNS: (_namespace, tagName) => new FakeDOMElement(tagName),
    };
    let queryErrorText = '';
    const queryFanout = await sample('query_fanout_25', async () => {
      let mountedQueryBlocks = 0;
      let renderedRows = 0;
      let errorNodes = 0;
      let domNodes = 0;
      for (let index = 0; index < 25; index += 1) {
        const rootElement = new FakeDOMElement('div');
        await queryRenderer.render('not done\nlimit 100', rootElement, { sourcePath: `Query/${index}.md` });
        const rows = rootElement.querySelectorAll('.task-manager-query-item').length;
        renderedRows += rows;
        const errors = rootElement.querySelectorAll('.task-manager-query-error');
        errorNodes += errors.length;
        if (!queryErrorText && errors[0]) queryErrorText = errors[0].text;
        if (rows > 0) mountedQueryBlocks += 1;
        domNodes += countDomNodes(rootElement);
      }
      return { counters: { inputTasks: tasks.length, mountedQueryBlocks, renderedRows, errorNodes, domNodes } };
    });
    globalThis.document = originalDocument;
    if (queryErrorText) console.error(`Query fanout diagnostic: ${queryErrorText}`);
    const dashboardModel = await sample('dashboard_model', () => {
      const model = dashboardTodayModel(tasks, '2026-07-12', 'today');
      const modelSections = ['overdue', 'blocked', 'today', 'tomorrow', 'backlog', 'recentlyDone'].filter((key) => model[key].length > 0).length;
      let lastRendered = 1;
      let pending = -1;
      let rejectedRevisionRequests = 0;
      for (const requested of [2, 2, 3, 3, 2]) {
        if (dashboardRevisionShouldRefresh(lastRendered, pending, requested)) pending = requested;
        else rejectedRevisionRequests += 1;
      }
      lastRendered = Math.max(lastRendered, pending);
      return Promise.resolve({ counters: { inputTasks: tasks.length, modelSections, rejectedRevisionRequests, lastRenderedRevision: lastRendered } });
    });

    const scanShapes = [];
    for (const fileCount of [100, 1000, 10000]) {
      const baseTasks = Math.floor(baseline.taskCount / fileCount);
      let remainder = baseline.taskCount % fileCount;
      const contents = new Map();
      const files = [];
      for (let fileIndex = 0; fileIndex < fileCount; fileIndex += 1) {
        const count = baseTasks + (remainder-- > 0 ? 1 : 0);
        const shapeFile = new TFile(`Shape/${fileCount}/${fileIndex}.md`);
        shapeFile.path = `Shape/${fileCount}/${fileIndex}.md`;
        shapeFile.name = `${fileIndex}.md`;
        shapeFile.basename = String(fileIndex);
        shapeFile.extension = 'md';
        files.push(shapeFile);
        contents.set(shapeFile.path, Array.from({ length: count }, (_value, taskIndex) => `- [ ] Task ${fileIndex}-${taskIndex}`).join('\n'));
      }
      let reads = 0;
      let bytesRead = 0;
      let parseCalls = 0;
      const shapeScanner = new TaskScanner({ vault: { read: async (target) => {
        const content = contents.get(target.path) ?? '';
        reads += 1;
        bytesRead += Buffer.byteLength(content);
        return content;
      } } });
      const metric = await sample(`scan_${fileCount}_files`, async () => {
        reads = 0;
        bytesRead = 0;
        parseCalls = 0;
        let taskCount = 0;
        const concurrency = 32;
        for (let index = 0; index < files.length; index += concurrency) {
          const parsed = await Promise.all(files.slice(index, index + concurrency).map((target) => { parseCalls += 1; return shapeScanner.scanFile(target); }));
          taskCount += parsed.reduce((sum, fileTasks) => sum + fileTasks.length, 0);
        }
        return { taskCount, counters: { bodyReads: reads, bytesRead, parseCalls } };
      });
      if (metric.value.taskCount !== baseline.taskCount || metric.counters.bodyReads !== fileCount) {
        console.error(`Benchmark shape ${fileCount} files produced ${metric.value.taskCount} tasks and ${metric.counters.bodyReads} reads; expected ${baseline.taskCount}/${fileCount}.`);
        return 1;
      }
      scanShapes.push(metric);
    }

    const orchestratedScenarios = [
      { mode: 'cold', fileCount: 1000, taskCount: baseline.taskCount },
      { mode: 'all-changed', fileCount: 1000, taskCount: baseline.taskCount },
      { mode: 'one-percent-dirty', fileCount: 1000, taskCount: baseline.taskCount },
      { mode: 'eight-day-one-dirty', fileCount: 10000, taskCount: baseline.taskCount },
      { mode: 'all-stat-matched', fileCount: 10000, taskCount: baseline.taskCount },
      { mode: 'dirty-burst', fileCount: 1000, taskCount: baseline.taskCount },
    ];
    const orchestrated = [];
    for (const scenario of orchestratedScenarios) {
      const worker = spawnSync(process.execPath, [
        '--expose-gc',
        'scripts/benchmark-worker.mjs',
        testDist,
        Buffer.from(JSON.stringify(scenario)).toString('base64url'),
        String(measuredSamples),
      ], { cwd: root, encoding: 'utf8' });
      if (worker.status !== 0) {
        console.error(worker.stderr || `Benchmark worker failed for ${scenario.mode}`);
        return worker.status ?? 1;
      }
      orchestrated.push(JSON.parse(worker.stdout.trim()));
    }

    const allMetrics = [
      generated, scanned, queried, queryUrgencyIds, queryUrgencySparse, queryUrgencyHub,
      sidebarHierarchy, sidebarDom, queryFanout, dashboardModel, ...scanShapes, ...orchestrated,
    ];
    const identity = computeSourceIdentity(root);
    const revision = sourceRevision(root);
    const results = {
      generatedAt: new Date().toISOString(),
      node: process.version,
      runtime: { platform: process.platform, arch: process.arch, release: os.release(), cpus: os.cpus().length },
      sourceRevision: revision,
      sourceContentSha256: identity.sha256,
      commit: revision === 'unavailable' ? null : revision,
      requestedTaskCount: baseline.taskCount,
      parsedTaskCount: tasks.length,
      profile: fullProfile ? 'full' : (baseline.profile ?? 'quick'),
      distributionShapes: [1, 100, 1000, 10000],
      metrics: Object.fromEntries(allMetrics.map(({ name, value: _value, ...metric }) => [name, metric])),
    };
    if (!structuralOnly) {
      const outputDir = path.join(root, 'benchmark-results');
      rmSync(outputDir, { recursive: true, force: true });
      mkdirSync(outputDir, { recursive: true });
      writeFileSync(path.join(outputDir, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);
    }

    let failed = false;
    if (!baseline.thresholdsMs || !baseline.p95ThresholdsMs || !baseline.counterExpectations
      || !Number.isFinite(baseline.peakHeapThresholdBytes) || !Number.isFinite(baseline.peakRssThresholdBytes)
      || !Number.isFinite(baseline.rssDeltaThresholdBytes)) {
      console.error('FAIL performance baseline is missing required median, p95, counter, heap, absolute RSS, or RSS-delta gates');
      failed = true;
    }
    const metricNames = Object.keys(results.metrics);
    for (const name of metricNames) {
      if (!(name in (baseline.thresholdsMs ?? {})) || !(name in (baseline.p95ThresholdsMs ?? {})) || !(name in (baseline.counterExpectations ?? {}))) {
        console.error(`FAIL metric ${name} is not covered by every baseline gate section`);
        failed = true;
      }
    }
    const requireMetric = (name) => {
      const metric = results.metrics[name];
      if (!metric) {
        console.error(`FAIL missing required benchmark metric: ${name}`);
        failed = true;
      }
      return metric;
    };
    if (!structuralOnly) {
      for (const [name, threshold] of Object.entries(baseline.thresholdsMs)) {
        const metric = requireMetric(name);
        if (!metric) continue;
        if (!Number.isFinite(metric.medianMs)) { console.error(`FAIL ${name}: median is missing or non-finite`); failed = true; continue; }
        const summary = `${name}: median ${metric.medianMs.toFixed(1)}ms (limit ${threshold}ms)`;
        if (metric.medianMs > threshold) { console.error(`FAIL ${summary}`); failed = true; }
        else console.log(`PASS ${summary}`);
      }
      for (const [name, threshold] of Object.entries(baseline.p95ThresholdsMs ?? {})) {
        const metric = requireMetric(name);
        if (!metric) continue;
        if (!Number.isFinite(metric.p95Ms)) { console.error(`FAIL ${name}: p95 is missing or non-finite`); failed = true; continue; }
        if (metric.p95Ms > threshold) { console.error(`FAIL ${name}: p95 ${metric.p95Ms.toFixed(1)}ms (limit ${threshold}ms)`); failed = true; }
      }
      for (const [name, metric] of Object.entries(results.metrics)) {
        if (metric.runtime && typeof metric.peakHeapDeltaBytes !== 'number') { console.error(`FAIL ${name}: peak heap evidence is missing`); failed = true; }
        if (typeof metric.peakHeapDeltaBytes === 'number' && metric.peakHeapDeltaBytes > baseline.peakHeapThresholdBytes) { console.error(`FAIL ${name}: peak heap delta ${metric.peakHeapDeltaBytes} exceeds ${baseline.peakHeapThresholdBytes}`); failed = true; }
        if (metric.runtime && !Number.isFinite(metric.peakRssBytes)) { console.error(`FAIL ${name}: peak RSS evidence is missing`); failed = true; }
        else if (metric.memoryIsolation === 'isolated-process' && metric.peakRssBytes > baseline.peakRssThresholdBytes) { console.error(`FAIL ${name}: isolated absolute peak RSS ${metric.peakRssBytes} exceeds ${baseline.peakRssThresholdBytes}`); failed = true; }
        if (metric.runtime && !Number.isFinite(metric.rssDeltaBytes)) { console.error(`FAIL ${name}: RSS-delta evidence is missing`); failed = true; }
        else if (metric.runtime && metric.rssDeltaBytes > baseline.rssDeltaThresholdBytes) { console.error(`FAIL ${name}: one-workload RSS delta ${metric.rssDeltaBytes} exceeds ${baseline.rssDeltaThresholdBytes}`); failed = true; }
        if (metric.runtime && metric.memoryIsolation !== 'shared-process' && metric.memoryIsolation !== 'isolated-process') { console.error(`FAIL ${name}: memory isolation provenance is missing`); failed = true; }
      }
    }
    for (const [name, expectations] of Object.entries(baseline.counterExpectations ?? {})) {
      const metric = requireMetric(name);
      if (!metric) continue;
      if (structuralOnly) console.log(`PASS ${name}: structural counters collected (timing gate intentionally disabled)`);
      if (!metric.counters) { console.error(`FAIL ${name}: required counters are missing`); failed = true; continue; }
      for (const [counter, expectation] of Object.entries(expectations)) {
        const actual = metric.counters[counter];
        if (typeof actual !== 'number'
          || (expectation.eq !== undefined && actual !== expectation.eq)
          || (expectation.max !== undefined && actual > expectation.max)
          || (expectation.min !== undefined && actual < expectation.min)) {
          console.error(`FAIL ${name}: counter ${counter}=${String(actual)} violates ${JSON.stringify(expectation)}`);
          failed = true;
        }
      }
    }
    return failed ? 1 : 0;
  } finally {
    rmSync(testDist, { recursive: true, force: true });
    try { rmdirSync(testRunsRoot); } catch { /* another test or benchmark still owns the directory */ }
  }
}

process.exitCode = await main();
