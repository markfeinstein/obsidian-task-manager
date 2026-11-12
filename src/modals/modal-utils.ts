/**
 * modal-utils.ts
 *
 * Utility functions shared by modal files that cannot import from main.ts
 * (to avoid circular dependencies).
 */
import type { App, TFile } from 'obsidian';
import type { TaskManagerSettings } from '../types';
import { scanFileWithTaskNotes, type ParsedTask, type TaskScanner } from '../task-scanner';

/** Return all markdown files in the vault excluding configured excluded folders. */
export function scannableMarkdownFiles(app: App, settings: Pick<TaskManagerSettings, 'excludedFolders'>): TFile[] {
  const excluded = settings.excludedFolders ?? [];
  const files = app.vault.getMarkdownFiles();
  if (excluded.length === 0) return files;
  return files.filter((file) => {
    const lowerPath = file.path.toLowerCase();
    return !excluded.some((prefix) => {
      const normalizedPrefix = prefix.trim().replace(/^\/+|\/+$/gu, '').toLowerCase();
      return Boolean(normalizedPrefix) && (lowerPath === normalizedPrefix || lowerPath.startsWith(`${normalizedPrefix}/`));
    });
  });
}

export async function scanScannableTasks(app: App, settings: TaskManagerSettings, scanner: TaskScanner): Promise<ParsedTask[]> {
  const tasks: ParsedTask[] = [];
  for (const file of scannableMarkdownFiles(app, settings)) {
    tasks.push(...await scanFileWithTaskNotes(file, app, scanner, settings));
  }
  return tasks;
}
