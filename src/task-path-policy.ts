import type { TFile } from 'obsidian';

function normalizedPrefix(value: string): string {
  return value.trim().replace(/^\/+|\/+$/gu, '').toLowerCase();
}

/** One segment-aware boundary for every task-index scan entry point. */
export function isIndexableTaskPath(
  path: string,
  extension: string | undefined,
  excludedFolders: readonly string[] = [],
): boolean {
  const normalizedExtension = (extension || (path.toLowerCase().endsWith('.canvas') ? 'canvas' : path.toLowerCase().endsWith('.md') ? 'md' : '')).toLowerCase();
  if (normalizedExtension !== 'md' && normalizedExtension !== 'canvas') return false;
  const lowerPath = path.replace(/^\/+|\/+$/gu, '').toLowerCase();
  return !excludedFolders.some((folder) => {
    const prefix = normalizedPrefix(folder);
    return prefix.length > 0 && (lowerPath === prefix || lowerPath.startsWith(`${prefix}/`));
  });
}

export function isIndexableTaskFile(file: Pick<TFile, 'path' | 'extension'>, excludedFolders: readonly string[] = []): boolean {
  return isIndexableTaskPath(file.path, file.extension, excludedFolders);
}
