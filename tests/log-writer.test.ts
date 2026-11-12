/**
 * LogWriter Tests
 * Tests for log entry formatting, especially template variable extraction
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { LogWriter } from '../src/log-writer';
import type { LogEntry } from '../src/log-writer';
import type { TaskManagerSettings } from '../src/types';
import type { App, TFile } from 'obsidian';

// Mock minimal settings
function mockSettings(): TaskManagerSettings {
  return {
    logEntryTemplate: '{{time}} {{task}} {{duration}}',
    includeCompletionTime: true,
    logTimeFormat: 'HH:mm',
    includeSourceLinkWhenNotDailyNote: false,
    logSectionHeading: 'Log',
  } as TaskManagerSettings;
}

// Mock minimal App
function mockApp(): App {
  return {
    vault: {
      cachedRead: async () => '',
    },
  } as unknown as App;
}

// Mock TFile
function mockFile(path: string): TFile {
  return { path } as TFile;
}

test('log-writer: extracts duration from end of task text', () => {
  const app = mockApp();
  const settings = mockSettings();
  settings.logEntryTemplate = 'duration={{duration}}';
  const writer = new LogWriter(app, () => settings);

  const entry: LogEntry = {
    text: 'Complete report - 2h 30m',
    completedAt: new Date('2026-06-09T10:00:00Z'),
  };

  const line = writer.formatLogLine(mockFile('daily/2026-06-09.md'), entry);
  assert.ok(line.includes('duration=2h 30m'), `Expected line to include 'duration=2h 30m', got: ${line}`);
});

test('log-writer: extracts duration in parentheses at end', () => {
  const app = mockApp();
  const settings = mockSettings();
  settings.logEntryTemplate = 'duration={{duration}}';
  const writer = new LogWriter(app, () => settings);

  const entry: LogEntry = {
    text: 'Fix bug (1h)',
    completedAt: new Date('2026-06-09T10:00:00Z'),
  };

  const line = writer.formatLogLine(mockFile('daily/2026-06-09.md'), entry);
  assert.ok(line.includes('duration=1h'), `Expected line to include 'duration=1h', got: ${line}`);
});

test('log-writer: extracts duration with spaces in parentheses', () => {
  const app = mockApp();
  const settings = mockSettings();
  settings.logEntryTemplate = 'duration={{duration}}';
  const writer = new LogWriter(app, () => settings);

  const entry: LogEntry = {
    text: 'Review PR (2h 15m)',
    completedAt: new Date('2026-06-09T10:00:00Z'),
  };

  const line = writer.formatLogLine(mockFile('daily/2026-06-09.md'), entry);
  assert.ok(line.includes('duration=2h 15m'), `Expected line to include 'duration=2h 15m', got: ${line}`);
});

test('log-writer: extracts minutes-only duration', () => {
  const app = mockApp();
  const settings = mockSettings();
  settings.logEntryTemplate = 'duration={{duration}}';
  const writer = new LogWriter(app, () => settings);

  const entry: LogEntry = {
    text: 'Quick fix 45m',
    completedAt: new Date('2026-06-09T10:00:00Z'),
  };

  const line = writer.formatLogLine(mockFile('daily/2026-06-09.md'), entry);
  assert.ok(line.includes('duration=45m'), `Expected line to include 'duration=45m', got: ${line}`);
});

test('log-writer: handles task without duration', () => {
  const app = mockApp();
  const settings = mockSettings();
  const writer = new LogWriter(app, () => settings);

  const entry: LogEntry = {
    text: 'Task without duration',
    completedAt: new Date('2026-06-09T10:00:00Z'),
  };

  const line = writer.formatLogLine(mockFile('daily/2026-06-09.md'), entry);
  // Should not throw, duration should be empty
  assert.ok(typeof line === 'string');
});

test('log-writer: stable completion marker makes append idempotent across restart retries', async () => {
  const settings = mockSettings();
  settings.logEntryTemplate = '';
  settings.includeCompletionTime = true;
  let content = '';
  const app = {
    vault: {
      cachedRead: async () => content,
      process: async (_file: TFile, updater: (current: string) => string) => { content = updater(content); },
      getAbstractFileByPath: () => null,
    },
    metadataCache: { fileToLinktext: () => '' },
  } as unknown as App;
  const writer = new LogWriter(app, () => settings);
  const daily = mockFile('daily/2026-06-09.md');
  const first = await writer.appendToDailyLog(daily, {
    text: 'Persist safely',
    completedAt: new Date('2026-06-09T10:00:00Z'),
    completionId: 'abc123',
  });
  const retry = await writer.appendToDailyLog(daily, {
    text: 'Persist safely',
    completedAt: new Date('2026-06-09T10:05:00Z'),
    completionId: 'abc123',
  });

  assert.equal((content.match(/task-manager-completion:abc123/gu) ?? []).length, 1);
  assert.equal(retry, first, 'retry returns the already persisted line for a stable hash');
});

test('log-writer: warns and falls back to global heading when note frontmatter cannot be read', async () => {
  const settings = mockSettings();
  settings.logSectionHeading = 'Completed';
  settings.logEntryTemplate = '';
  settings.includeCompletionTime = false;
  const processed: { content?: string } = {};
  const app = {
    vault: {
      cachedRead: async () => {
        throw new Error('disk read failed');
      },
      process: async (_file: TFile, updater: (content: string) => string) => {
        processed.content = updater('');
      },
    },
  } as unknown as App;
  const writer = new LogWriter(app, () => settings);
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((value) => String(value)).join(' '));
  };

  try {
    await writer.appendToDailyLog(mockFile('daily/2026-06-09.md'), {
      text: 'Task without frontmatter override',
      completedAt: new Date('2026-06-09T10:00:00Z'),
    });
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? '', /Failed to read frontmatter override/);
  assert.match(warnings[0] ?? '', /daily\/2026-06-09\.md/);
  assert.equal(processed.content, '## Completed\n- Task without frontmatter override\n');
});
