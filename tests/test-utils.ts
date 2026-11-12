/**
 * Test Utilities and Mocks
 *
 * Provides:
 * - Mock Obsidian App and Vault
 * - Fake DOM elements for rendering tests
 * - Fixture markdown files
 * - Test data builders
 */

import { TFile, TFolder } from 'obsidian';
import type { App, CachedMetadata, FileStats, TAbstractFile } from 'obsidian';
import type { ParsedTask } from '../src/task-scanner';

/**
 * FakeFile: Mock TFile for testing
 */
export class FakeFile extends TFile {
  stat: FileStats = { ctime: Date.now(), mtime: Date.now(), size: 0 };
  parent = null;
  vault = {} as never;
  path: string;
  name: string;
  extension: string;
  basename: string;
  isFolder(): false { return false; }

  constructor(path: string, name: string, extension = 'md', basename = name.replace(/\.md$/u, '')) {
    super();
    this.path = path;
    this.name = name;
    this.extension = extension;
    this.basename = basename;
  }
}

/**
 * FakeFolder: Mock TFolder for testing
 */
export class FakeFolder extends TFolder {
  stat: FileStats = { ctime: Date.now(), mtime: Date.now(), size: 0 };
  children: (FakeFile | FakeFolder)[] = [];
  parent = null;
  vault = {} as never;
  path: string;
  name: string;
  isFolder(): true { return true; }

  constructor(path: string, name: string) {
    super();
    this.path = path;
    this.name = name;
  }
}

/**
 * FakeDOMElement: Mock DOM element for rendering tests
 */
export class FakeDOMElement {
  classes: string[] = [];
  classList = {
    add: (...classNames: string[]) => this.addClass(...classNames),
    remove: (...classNames: string[]) => {
      for (const className of classNames) this.removeClass(className);
    },
    toggle: (className: string, force?: boolean) => this.toggleClass(className, force),
    contains: (className: string) => this.classes.includes(className),
  };
  attributes: Map<string, string> = new Map();
  dataset: Record<string, string> = {};
  style: any = {
    setProperty: (name: string, value: string) => {
      this.style[name] = value;
    },
  };
  children: (FakeDOMElement | FakeDOMTextNode)[] = [];
  text = '';
  checked = false;
  disabled = false;
  value = '';
  listeners: Map<string, Function> = new Map();
  private eventListeners: Map<string, Function[]> = new Map();
  parent: FakeDOMElement | null = null;

  constructor(readonly tagName: string = 'div') {}

  addClass(...classNames: string[]): void {
    for (const cls of classNames) {
      if (!this.classes.includes(cls)) {
        this.classes.push(cls);
      }
    }
  }

  removeClass(className: string): void {
    this.classes = this.classes.filter((c) => c !== className);
  }

  toggleClass(className: string, force?: boolean): void {
    if (force === undefined) {
      if (this.classes.includes(className)) {
        this.removeClass(className);
      } else {
        this.addClass(className);
      }
    } else if (force) {
      this.addClass(className);
    } else {
      this.removeClass(className);
    }
  }

  setAttr(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  setAttribute(name: string, value: string): void {
    this.setAttr(name, value);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  getAttr(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  setText(text: string): void {
    this.text = text;
  }

  empty(): void {
    this.children = [];
    this.text = '';
  }

  appendChild(child: FakeDOMElement | FakeDOMTextNode): FakeDOMElement | FakeDOMTextNode {
    this.children.push(child);
    if (child instanceof FakeDOMElement) child.parent = this;
    return child;
  }

  prepend(child: FakeDOMElement | FakeDOMTextNode): void {
    this.children.unshift(child);
    if (child instanceof FakeDOMElement) child.parent = this;
  }

  insertBefore(child: FakeDOMElement | FakeDOMTextNode, reference: FakeDOMElement | FakeDOMTextNode | null): FakeDOMElement | FakeDOMTextNode {
    const index = reference ? this.children.indexOf(reference) : -1;
    if (index >= 0) this.children.splice(index, 0, child);
    else this.children.push(child);
    if (child instanceof FakeDOMElement) child.parent = this;
    return child;
  }

  createDiv(opts?: string | { cls?: string; text?: string }): FakeDOMElement {
    const el = new FakeDOMElement('div');
    if (typeof opts === 'string') {
      el.addClass(...opts.split(' '));
    } else {
      if (opts?.cls) el.addClass(...opts.cls.split(' '));
      if (opts?.text) el.setText(opts.text);
    }
    this.appendChild(el);
    return el;
  }

  createEl(tag: string, opts?: { cls?: string; text?: string; type?: string }): FakeDOMElement {
    const el = new FakeDOMElement(tag);
    if (opts?.cls) el.addClass(...opts.cls.split(' '));
    if (opts?.text) el.setText(opts.text);
    if (opts?.type) el.setAttr('type', opts.type);
    this.appendChild(el);
    return el;
  }

  querySelector(selector: string): FakeDOMElement | null {
    const classMatch = selector.match(/^\.([\w-]+)$/);
    if (classMatch) return this.findByClass(classMatch[1]) ?? null;
    const idMatch = selector.match(/^#([\w-]+)$/);
    if (idMatch) return this.findById(idMatch[1]) ?? null;
    return null;
  }

  querySelectorAll(selector: string): FakeDOMElement[] {
    const classMatch = selector.match(/^\.([\w-]+)$/);
    if (classMatch) return this.findAllByClass(classMatch[1]);
    return [];
  }

  addEventListener(eventName: string, listener: Function): void {
    const registered = this.eventListeners.get(eventName) ?? [];
    registered.push(listener);
    this.eventListeners.set(eventName, registered);
    this.listeners.set(eventName, (...args: unknown[]) => {
      for (const callback of [...registered]) callback(...args);
    });
  }

  removeEventListener(eventName: string, listener: Function): void {
    const registered = this.eventListeners.get(eventName);
    if (!registered) return;
    const next = registered.filter((callback) => callback !== listener);
    this.eventListeners.set(eventName, next);
    if (next.length === 0) this.listeners.delete(eventName);
    else this.listeners.set(eventName, (...args: unknown[]) => {
      for (const callback of [...next]) callback(...args);
    });
  }

  dispatchEvent(event: { type: string }): boolean {
    this.listeners.get(event.type)?.(event);
    return true;
  }

  getBoundingClientRect(): { left: number; bottom: number } {
    return { left: 0, bottom: 0 };
  }

  focus(): void {}

  remove(): void {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((child) => child !== this);
    this.parent = null;
  }

  contains(node: unknown): boolean {
    if (node === this) return true;
    for (const child of this.children) {
      if (child instanceof FakeDOMElement && child.contains(node)) return true;
    }
    return false;
  }

  private findByClass(className: string): FakeDOMElement | undefined {
    if (this.classes.includes(className)) return this;
    for (const child of this.children) {
      if (child instanceof FakeDOMElement) {
        const found = child.findByClass(className);
        if (found) return found;
      }
    }
    return undefined;
  }

  private findById(id: string): FakeDOMElement | undefined {
    if (this.getAttr('id') === id) return this;
    for (const child of this.children) {
      if (child instanceof FakeDOMElement) {
        const found = child.findById(id);
        if (found) return found;
      }
    }
    return undefined;
  }

  private findAllByClass(className: string): FakeDOMElement[] {
    const results: FakeDOMElement[] = [];
    if (this.classes.includes(className)) results.push(this);
    for (const child of this.children) {
      if (child instanceof FakeDOMElement) {
        results.push(...child.findAllByClass(className));
      }
    }
    return results;
  }

  getInnerText(): string {
    if (this.text) return this.text;
    let result = '';
    for (const child of this.children) {
      if (child instanceof FakeDOMElement) {
        result += child.getInnerText();
      } else if (child instanceof FakeDOMTextNode) {
        result += child.text;
      }
    }
    return result;
  }
}

/**
 * FakeDOMTextNode: Mock text node
 */
export class FakeDOMTextNode {
  constructor(readonly text: string) {}
}

/**
 * Mock App: Provides obsidian app API
 */
export class MockApp implements Partial<App> {
  vault = new MockVault() as any;
  metadataCache = new MockMetadataCache() as any;
  lastEvent?: any;
}

/**
 * Mock Vault: File and folder operations
 */
export class MockVault {
  files: Map<string, { content: string; mtime: number }> = new Map();
  folders: Map<string, true> = new Map();
  private events = new Map<string, Set<(...args: unknown[]) => void>>();

  on(eventName: string, callback: (...args: unknown[]) => unknown): { off: () => void } {
    const listeners = this.events.get(eventName) ?? new Set();
    const listener = callback as (...args: unknown[]) => void;
    listeners.add(listener);
    this.events.set(eventName, listeners);
    return { off: () => listeners.delete(listener) };
  }

  trigger(eventName: string, ...args: unknown[]): void {
    for (const listener of this.events.get(eventName) ?? []) listener(...args);
  }

  async read(file: TFile): Promise<string> {
    return this.files.get(file.path)?.content ?? '';
  }

  async modify(file: TFile, content: string): Promise<void> {
    const entry = this.files.get(file.path);
    if (entry) {
      entry.content = content;
      entry.mtime = Date.now();
    }
    this.trigger('modify', file);
  }

  async create(path: string, content: string): Promise<TFile> {
    this.files.set(path, { content, mtime: Date.now() });
    const file = new FakeFile(path, path.split('/').pop() ?? path);
    this.trigger('create', file);
    return file;
  }

  async rename(file: TFile, newPath: string): Promise<void> {
    const oldPath = file.path;
    const entry = this.files.get(oldPath);
    if (entry) {
      this.files.delete(oldPath);
      this.files.set(newPath, entry);
    }
    file.path = newPath;
    file.name = newPath.split('/').pop() ?? newPath;
    this.trigger('rename', file, oldPath);
  }

  async delete(file: TFile): Promise<void> {
    this.files.delete(file.path);
    this.trigger('delete', file);
  }

  getAbstractFileByPath(path: string): TAbstractFile | null {
    if (this.files.has(path)) {
      return new FakeFile(path, path.split('/').pop() ?? path);
    }
    if (this.folders.has(path)) {
      return new FakeFolder(path, path.split('/').pop() ?? path);
    }
    return null;
  }

  getFiles(): TFile[] {
    return Array.from(this.files.keys()).map(
      (path) => new FakeFile(path, path.split('/').pop() ?? path),
    );
  }
}

/**
 * Mock MetadataCache: File metadata tracking
 */
export class MockMetadataCache {
  cache: Map<string, CachedMetadata> = new Map();

  getFileCache(file: TFile): CachedMetadata | null {
    return this.cache.get(file.path) ?? null;
  }

  getCache(path: string): CachedMetadata | null {
    return this.cache.get(path) ?? null;
  }

  setFileCache(path: string, metadata: CachedMetadata): void {
    this.cache.set(path, metadata);
  }
}

/**
 * Fixture: Standard markdown task files
 */
export const FIXTURE_MARKDOWN = {
  simple: `# Task Management

- [ ] Buy milk
- [ ] Review PR
- [x] Completed task`,

  withDates: `# Projects

- [ ] Launch feature 📅 2026-06-15
- [ ] Code review 📅 2026-06-10 🚀 2026-06-09
- [x] Previous task 📅 2026-05-20 ✅ 2026-05-25`,

  withPriority: `# Urgent

- [ ] Fix critical bug 🔺
- [ ] High priority task ⏫
- [ ] Normal priority 🔼
- [ ] Low priority task 🔽`,

  withRecurrence: `# Habits

- [ ] Daily standup ↩️ every weekday
- [ ] Weekly review ↩️ every Monday
- [ ] Monthly report ↩️ every 1st of the month`,

  withEffort: `# Estimates

- [ ] Short task ⏱️ 15m
- [ ] Medium task ⏱️ 2h
- [ ] Long task ⏱️ 3d`,

  nested: `# Parent Task

- [ ] Parent item
  - [ ] Child 1
  - [ ] Child 2
    - [ ] Grandchild
  - [x] Child 3`,

  complex: `# Full Featured

- [ ] Deploy service 📅 2026-06-01 🚀 2026-05-29 🔺 ⏱️ 4h 💵 500 🆔 deploy #urgent #ops ↩️ every sprint
  - [ ] Run tests
  - [ ] Review code`,
};

/**
 * Builder: Create mock ParsedTask for testing
 */
export function createMockTask(overrides: Partial<ParsedTask> = {}): ParsedTask {
  const baseTask: ParsedTask = {
    checkbox: ' ',
    body: 'Mock task',
    filePath: 'Test.md',
    lineNumber: 1,
    rawLine: '- [ ] Mock task',
    heading: '',
    tags: [],
    normalizedText: 'Mock task',
    key: 'test-key',
    linePrefix: '',
    indentation: '',
    listMarker: '-',
    status: 'todo',
    contexts: [],
    metadata: {
      dates: {
        due: '',
        scheduled: '',
        start: '',
        done: '',
        created: '',
        cancelled: '',
      },
      invalidDates: {},
      priority: 'normal',
      recurrence: '',
      id: '',
      dependsOn: [],
      onCompletion: '',
      reminder: '',
      effort: '',
      actual: '',
      followUp: '',
      pinned: false,
      cost: 0,
    },
  };
  return { ...baseTask, ...overrides } as ParsedTask;
}

/**
 * Helper: Get today's date in YYYY-MM-DD format
 */
export function getTodayString(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/**
 * Helper: Get date N days from today
 */
export function getDatePlusDays(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/**
 * Helper: Parse effort string (e.g., "2h" -> minutes)
 */
export function parseEffortToMinutes(effort: string): number {
  if (!effort) return 0;
  const match = effort.match(/^(\d+(?:\.\d+)?)(h|m|d)$/);
  if (!match) return 0;
  const [, value, unit] = match;
  const num = parseFloat(value);
  switch (unit) {
    case 'h': return num * 60;
    case 'd': return num * 480;
    default: return num;
  }
}

/**
 * Helper: Format minutes as effort string (e.g., 120 -> "2h")
 */
export function minutesToEffort(minutes: number): string {
  if (minutes === 0) return '';
  if (minutes >= 480 && minutes % 480 === 0) return `${minutes / 480}d`;
  if (minutes >= 60 && minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

/**
 * Helper: Extract text content from fake DOM element
 */
export function extractTextContent(el: FakeDOMElement): string {
  return el.getInnerText().trim();
}

/**
 * Helper: Find elements by class
 */
export function findElementsByClass(root: FakeDOMElement, className: string): FakeDOMElement[] {
  return root.querySelectorAll(`.${className}`);
}

/**
 * Create mock vault from markdown content
 * 
 * Supports:
 * - Tasks plugin format (emoji markers)
 * - Reminder plugin format ((@date) syntax)
 * - Kanban boards (YAML frontmatter)
 * - Dataview fields ([field:: value])
 * - Task Genius format (custom checkboxes)
 * - Large vaults (10K+ tasks)
 */
export interface MockVaultOptions {
  files?: Map<string, string>;
  rootPath?: string;
}

export function createMockVault(options: MockVaultOptions = {}): MockVault {
  const vault = new MockVault();
  const { files = new Map(), rootPath = '' } = options;
  
  for (const [filePath, content] of files) {
    const fullPath = rootPath ? `${rootPath}/${filePath}` : filePath;
    vault.files.set(fullPath, { content, mtime: Date.now() });
  }
  
  return vault;
}

/**
 * Helper: Parse Tasks plugin format (emoji markers)
 */
export function parseTasksPluginFormat(line: string): {
  hasDate?: boolean;
  priority?: string;
  effort?: string;
  recurrence?: string;
} {
  return {
    hasDate: /📅|🚀|⏫|✅|❌/.test(line),
    priority: line.match(/🔺{1,2}|⏫|🔼|🔽/)?.[0],
    effort: line.match(/⏱️\s*([^\s]+)/)?.[1],
    recurrence: line.match(/↩️\s*(.+?)(?:\s|$)/)?.[1],
  };
}

/**
 * Helper: Parse Reminder plugin format ((@date) syntax)
 */
export function parseReminderFormat(line: string): string[] {
  const matches = line.match(/@(\d{4}-\d{2}-\d{2}(?:\s\d{2}:\d{2})?)/g);
  return matches?.map(m => m.slice(1)) ?? [];
}

/**
 * Helper: Parse Dataview inline fields ([field:: value])
 */
export function parseDataviewFields(line: string): Record<string, string> {
  const fields: Record<string, string> = {};
  
  // Match [key:: value] patterns using regex
  // Handles nested brackets like [[links]]
  const fieldPattern = /\[([a-zA-Z_][a-zA-Z0-9_]*)::([^\]]*(?:\[\[[^\]]*\]\][^\]]*)*)\]/g;
  let match;
  
  while ((match = fieldPattern.exec(line)) !== null) {
    const [, key, value] = match;
    if (key && value) {
      fields[key] = value.trim();
    }
  }
  
  return fields;
}

/**
 * Helper: Parse Task Genius custom checkboxes
 */
export function parseTaskGeniusCheckbox(checkbox: string): string {
  const types: Record<string, string> = {
    ' ': 'todo',
    'x': 'done',
    '-': 'cancelled',
    '/': 'in-progress',
    '>': 'delegated',
    '<': 'waiting',
    '?': 'question',
    '!': 'important',
    '+': 'added',
    '~': 'recurring',
  };
  return types[checkbox] ?? 'unknown';
}

/**
 * Helper: Extract YAML frontmatter from markdown
 */
export function extractYAMLFrontmatter(content: string): Record<string, unknown> {
  const match = content.match(/^---\n([\s\S]+?)\n---/);
  if (!match) return {};
  
  const yaml = match[1];
  const obj: Record<string, unknown> = {};
  
  for (const line of yaml.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim();
      const value = line.slice(colonIdx + 1).trim();
      obj[key] = value === 'true' ? true : value === 'false' ? false : value;
    }
  }
  
  return obj;
}
