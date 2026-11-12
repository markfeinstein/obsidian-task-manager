import { normalizePath, TFile, type App } from 'obsidian';

export function normalizeVaultRelativePath(rawPath: string, fieldName = 'Vault path'): string {
  const raw = rawPath.trim().replace(/\\/gu, '/');
  if (!raw || raw.includes('\0') || raw.startsWith('/') || /^\/?[A-Za-z]:\//u.test(raw) || raw.startsWith('//')) {
    throw new Error(`${fieldName} must be a non-empty path relative to the vault root`);
  }
  const segments = raw.split('/');
  if (segments.some((segment) => segment === '..' || segment === '.')) {
    throw new Error(`${fieldName} must not contain . or .. path segments`);
  }
  const normalized = normalizePath(raw).replace(/^\/+|\/+$/gu, '');
  if (!normalized) throw new Error(`${fieldName} must be a non-empty path relative to the vault root`);
  return normalized;
}

export async function ensureParentFolders(app: App, filePath: string, assertCurrent: () => void = () => undefined): Promise<void> {
  const parentPath = filePath.split('/').slice(0, -1).join('/');
  if (!parentPath) return;

  let currentPath = '';
  for (const part of parentPath.split('/').filter(Boolean)) {
    assertCurrent();
    currentPath = currentPath ? `${currentPath}/${part}` : part;
    const existing = app.vault.getAbstractFileByPath(currentPath);
    if (existing instanceof TFile) {
      throw new Error(`Cannot create folder ${currentPath}: a file already exists at that path`);
    }
    if (existing) continue;

    try {
      assertCurrent();
      await app.vault.createFolder(currentPath);
      assertCurrent();
    } catch (error) {
      assertCurrent();
      // Another writer may have created the folder after the lookup. Re-check
      // before surfacing the error so concurrent captures/imports stay safe.
      const retryExisting = app.vault.getAbstractFileByPath(currentPath);
      if (!retryExisting || retryExisting instanceof TFile) {
        throw error;
      }
    }
  }
}
