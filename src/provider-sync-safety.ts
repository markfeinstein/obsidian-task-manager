import { type App, TFile } from 'obsidian';
import { ensureParentFolders } from './vault-utils';

export type ProviderSyncKey = 'todoist' | 'google-tasks' | 'google-calendar' | 'microsoft-todo' | 'caldav';
export type ImportProvider = 'todoist' | 'google-tasks' | 'microsoft-todo';

export interface ProviderRunContext {
  readonly generation: number;
  readonly signal: AbortSignal;
  readonly isCurrent: () => boolean;
}

export class ProviderRunCancelledError extends Error {
  constructor() {
    super('Provider run was cancelled');
    this.name = 'ProviderRunCancelledError';
  }
}

export function assertProviderRunCurrent(context: ProviderRunContext | undefined): void {
  if (context && (context.signal.aborted || !context.isCurrent())) throw new ProviderRunCancelledError();
}

export function isProviderRunCancellation(error: unknown): boolean {
  return error instanceof ProviderRunCancelledError
    || Boolean(error && typeof error === 'object' && (error as { code?: unknown }).code === 'cancelled')
    || error instanceof DOMException && error.name === 'AbortError';
}

export interface ProviderImportCandidate<T> {
  externalId: string;
  markdown: string;
  value: T;
}

export class ProviderSyncCoordinator {
  private readonly active = new Map<ProviderSyncKey, Promise<void>>();

  run(key: ProviderSyncKey, start: () => Promise<void>): Promise<void> {
    const existing = this.active.get(key);
    if (existing) return existing;
    const run = Promise.resolve().then(start).finally(() => {
      if (this.active.get(key) === run) this.active.delete(key);
    });
    this.active.set(key, run);
    return run;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function providerMarkerPattern(provider: ImportProvider, externalId: string): RegExp {
  const prefixes = provider === 'todoist'
    ? 'todoist:|todoist-'
    : provider === 'google-tasks' ? 'google-tasks:|gtasks-' : 'ms-todo:|microsoft-todo:';
  return new RegExp(String.raw`\[id::\s*(?:${prefixes})${escapeRegExp(externalId)}\s*\]`, 'u');
}

export function appendMissingProviderImports<T>(
  current: string,
  provider: ImportProvider,
  candidates: readonly ProviderImportCandidate<T>[],
): { content: string; committed: ProviderImportCandidate<T>[] } {
  const seen = new Set<string>();
  const committed = candidates.filter((candidate) => {
    if (seen.has(candidate.externalId) || providerMarkerPattern(provider, candidate.externalId).test(current)) return false;
    seen.add(candidate.externalId);
    return true;
  });
  if (committed.length === 0) return { content: current, committed: [] };
  const eol = current.includes('\r\n') ? '\r\n' : '\n';
  const markdown = committed.map((candidate) => candidate.markdown.replace(/\r?\n/gu, eol)).join(eol);
  const separator = current.length === 0 || current.endsWith(eol) ? '' : eol;
  return { content: `${current}${separator}${markdown}${eol}`, committed };
}

export async function commitProviderImports<T>(
  app: App,
  path: string,
  provider: ImportProvider,
  candidates: readonly ProviderImportCandidate<T>[],
  context?: ProviderRunContext,
): Promise<ProviderImportCandidate<T>[]> {
  assertProviderRunCurrent(context);
  if (candidates.length === 0) return [];
  const process = async (file: TFile): Promise<ProviderImportCandidate<T>[]> => {
    let committed: ProviderImportCandidate<T>[] = [];
    let cancelled = false;
    assertProviderRunCurrent(context);
    await app.vault.process(file, (current) => {
      if (context && !context.isCurrent()) { cancelled = true; return current; }
      const result = appendMissingProviderImports(current, provider, candidates);
      committed = result.committed;
      return result.content;
    });
    if (cancelled) throw new ProviderRunCancelledError();
    assertProviderRunCurrent(context);
    return committed;
  };
  const existing = app.vault.getAbstractFileByPath(path);
  if (existing instanceof TFile) return process(existing);
  if (existing) throw new Error(`Provider import path is not a file: ${path}`);
  assertProviderRunCurrent(context);
  await ensureParentFolders(app, path, () => assertProviderRunCurrent(context));
  assertProviderRunCurrent(context);
  const initial = appendMissingProviderImports('', provider, candidates);
  try {
    assertProviderRunCurrent(context);
    await app.vault.create(path, initial.content);
    assertProviderRunCurrent(context);
    return initial.committed;
  } catch (error) {
    if (isProviderRunCancellation(error) || context && !context.isCurrent()) throw new ProviderRunCancelledError();
    const raced = app.vault.getAbstractFileByPath(path);
    if (raced instanceof TFile) return process(raced);
    throw error;
  }
}
