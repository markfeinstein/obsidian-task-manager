import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

export const REQUIRED_RELEASE_FILES = ['main.js', 'manifest.json', 'versions.json', 'styles.css'];
export const MAX_BUNDLE_BYTES = 2 * 1024 * 1024;

/** Reserve a fresh output atomically; never delete or overwrite retained release evidence. */
export function createReleaseDirectory(releaseRoot) {
  try { mkdirSync(releaseRoot); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Refusing to replace existing release output: ${releaseRoot}. Preserve it and use a fresh checkout/output before retrying.`, { cause: error });
    throw error;
  }
}

export function readJsonFile(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

export function validateVersionConsistency({ packageJson, packageLockJson, manifestJson, versionsJson }) {
  const errors = [];

  if (!packageJson?.version) {
    errors.push('package.json is missing version');
  }
  if (!manifestJson?.version) {
    errors.push('manifest.json is missing version');
  }
  if (!manifestJson?.minAppVersion) {
    errors.push('manifest.json is missing minAppVersion');
  }

  if (packageJson?.version && manifestJson?.version && packageJson.version !== manifestJson.version) {
    errors.push(`package.json version (${packageJson.version}) must match manifest.json version (${manifestJson.version})`);
  }

  if (packageJson?.version && packageLockJson?.version && packageJson.version !== packageLockJson.version) {
    errors.push(`package-lock.json version (${packageLockJson.version}) must match package.json version (${packageJson.version})`);
  }

  const rootPackageVersion = packageLockJson?.packages?.['']?.version;
  if (packageJson?.version && rootPackageVersion && packageJson.version !== rootPackageVersion) {
    errors.push(`package-lock root package version (${rootPackageVersion}) must match package.json version (${packageJson.version})`);
  }

  if (manifestJson?.version && manifestJson?.minAppVersion) {
    const versionMinAppVersion = versionsJson?.[manifestJson.version];
    if (versionMinAppVersion !== manifestJson.minAppVersion) {
      errors.push(
        `versions.json must map ${manifestJson.version} to manifest minAppVersion ${manifestJson.minAppVersion}`,
      );
    }
  }

  return errors;
}

function gitDiffAgainstHead(rootDir, files) {
  const output = execFileSync('git', ['diff', '--name-only', 'HEAD', '--', ...files], {
    cwd: rootDir,
    encoding: 'utf8',
  });
  return output.split('\n').map((line) => line.trim()).filter(Boolean);
}

/**
 * Returns the subset of release artifacts whose on-disk contents differ from the
 * version committed at HEAD. After a fresh `build:prod`, any difference means the
 * tracked artifacts are stale relative to source and must be rebuilt/committed
 * before release. Mirrors the CI `git diff --exit-code` guard so the local
 * release gate catches the same problem.
 *
 * The git invocation is injectable to keep the logic unit-testable without a
 * throwaway git fixture.
 */
export function findOutdatedReleaseArtifacts(rootDir, requiredFiles = REQUIRED_RELEASE_FILES, runGitDiff = gitDiffAgainstHead) {
  const changed = new Set(runGitDiff(rootDir, requiredFiles));
  return requiredFiles.filter((file) => changed.has(file));
}

export function validateRequiredReleaseFiles(rootDir, requiredFiles = REQUIRED_RELEASE_FILES) {
  const errors = [];

  for (const file of requiredFiles) {
    const absolutePath = path.join(rootDir, file);
    if (!existsSync(absolutePath)) {
      errors.push(`${file} is missing`);
      continue;
    }

    try {
      execFileSync('git', ['ls-files', '--error-unmatch', file], {
        cwd: rootDir,
        stdio: 'ignore',
      });
    } catch {
      errors.push(`${file} must be tracked by git`);
    }
  }

  return errors;
}

export function validateManifestSchema(manifest) {
  const errors = [];
  for (const key of ['id', 'name', 'version', 'minAppVersion', 'description', 'author']) {
    if (typeof manifest?.[key] !== 'string' || manifest[key].trim() === '') errors.push(`manifest.json ${key} must be a non-empty string`);
  }
  if (typeof manifest?.id === 'string' && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(manifest.id)) {
    errors.push('manifest.json id must use lowercase letters, digits, and single hyphens');
  }
  if (typeof manifest?.id === 'string' && /obsidian/u.test(manifest.id)) {
    errors.push('manifest.json id must not contain "obsidian" (Obsidian Community Plugins rule)');
  }
  if (typeof manifest?.id === 'string' && /plugin$/u.test(manifest.id)) {
    errors.push('manifest.json id must not end with "plugin" (Obsidian Community Plugins rule)');
  }
  for (const key of ['version', 'minAppVersion']) {
    if (typeof manifest?.[key] === 'string' && !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(manifest[key])) {
      errors.push(`manifest.json ${key} must be a semantic version`);
    }
  }
  if (typeof manifest?.isDesktopOnly !== 'boolean') errors.push('manifest.json isDesktopOnly must be boolean');
  if (manifest?.authorUrl !== undefined) {
    try {
      const authorUrl = new URL(manifest.authorUrl);
      if (authorUrl.protocol !== 'https:') errors.push('manifest.json authorUrl must use HTTPS');
    } catch {
      errors.push('manifest.json authorUrl must be a valid URL');
    }
  }
  return errors;
}

export function validateBundleSource(source) {
  const errors = [];
  for (const forbidden of ['node:http', 'node:https', 'node:crypto', 'node:dns', 'mcp-server.ts']) {
    if (source.includes(forbidden)) errors.push(`main.js contains desktop-only production dependency marker: ${forbidden}`);
  }
  for (const lookbehind of ['(?<=', '(?<!']) {
    if (source.includes(lookbehind)) errors.push(`main.js contains regex lookbehind incompatible with the supported older-mobile runtime: ${lookbehind}`);
  }
  return errors;
}

export function validateInitialAssetBudgets(rootDir, budgets) {
  const required = ['mainJsBytes', 'stylesCssBytes', 'totalInitialBytes'];
  if (!budgets || required.some((key) => !Number.isInteger(budgets[key]) || budgets[key] <= 0)) {
    return ['initial asset budgets must define positive integer mainJsBytes, stylesCssBytes, and totalInitialBytes'];
  }
  const mainPath = path.join(rootDir, 'main.js');
  const stylesPath = path.join(rootDir, 'styles.css');
  if (!existsSync(mainPath) || !existsSync(stylesPath)) return [];
  const mainBytes = statSync(mainPath).size;
  const stylesBytes = statSync(stylesPath).size;
  const errors = [];
  if (mainBytes > budgets.mainJsBytes) errors.push(`main.js is ${mainBytes} bytes, exceeding the ${budgets.mainJsBytes}-byte initial asset budget`);
  if (stylesBytes > budgets.stylesCssBytes) errors.push(`styles.css is ${stylesBytes} bytes, exceeding the ${budgets.stylesCssBytes}-byte initial asset budget`);
  if (mainBytes + stylesBytes > budgets.totalInitialBytes) errors.push(`initial JS+CSS is ${mainBytes + stylesBytes} bytes, exceeding the ${budgets.totalInitialBytes}-byte total budget`);
  return errors;
}

export function validateBundleSize(rootDir, maxBytes = MAX_BUNDLE_BYTES) {
  const bundle = path.join(rootDir, 'main.js');
  if (!existsSync(bundle)) return ['main.js is missing'];
  const size = statSync(bundle).size;
  return size <= maxBytes ? [] : [`main.js is ${size} bytes, exceeding the ${maxBytes}-byte release limit`];
}

export function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

export function validateStagedRelease(packageDir, requiredFiles = REQUIRED_RELEASE_FILES) {
  if (!existsSync(packageDir)) return [`release package directory is missing: ${packageDir}`];
  const actual = readdirSync(packageDir).sort();
  const expected = [...requiredFiles].sort();
  return actual.length === expected.length && actual.every((file, index) => file === expected[index])
    ? []
    : [`release package must contain exactly ${expected.join(', ')}; found ${actual.join(', ') || '(empty)'}`];
}

export function validateReleaseMetadata(rootDir) {
  const packageJson = readJsonFile(path.join(rootDir, 'package.json'));
  const packageLockJson = readJsonFile(path.join(rootDir, 'package-lock.json'));
  const manifestJson = readJsonFile(path.join(rootDir, 'manifest.json'));
  const versionsJson = readJsonFile(path.join(rootDir, 'versions.json'));
  return [
    ...validateVersionConsistency({ packageJson, packageLockJson, manifestJson, versionsJson }),
    ...validateManifestSchema(manifestJson),
  ];
}
