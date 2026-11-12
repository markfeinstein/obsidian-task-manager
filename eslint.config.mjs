// @ts-check
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['node_modules/**', '.test-dist/**', '.test-dist-tq/**', 'main.js'],
  },
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        project: './tsconfig.eslint.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Catches unhandled promises — a common source of silent failures in Obsidian plugins
      '@typescript-eslint/no-floating-promises': 'error',
      // Allow explicit `as any` where truly needed (we prefer typed casts but won't ban them)
      '@typescript-eslint/no-explicit-any': 'warn',
      // Allow empty catch blocks when they intentionally swallow errors
      '@typescript-eslint/no-empty-function': 'off',
      // Allow non-null assertions — the codebase uses them deliberately
      '@typescript-eslint/no-non-null-assertion': 'warn',
      // Disabling these base rules to avoid false positives in TS files
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['*.mjs', 'scripts/**/*.mjs', 'tests/**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    files: ['tests/**/*.ts'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      parserOptions: {
        project: false,
      },
    },
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
      // Existing test fixtures use CommonJS mocks and intentionally loose helper types.
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-unsafe-function-type': 'off',
      'prefer-const': 'off',
    },
  },
  {
    files: [
      'tests/accessibility-dom.test.ts',
      'tests/dom-harness.ts',
      'tests/obsidian-harness.test.ts',
      'tests/plugin-lifecycle-smoke.test.ts',
      'tests/i18n.test.ts',
      'tests/query-result-paging.test.ts',
    ],
    languageOptions: {
      parserOptions: {
        project: './tsconfig.test.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
    },
  },
);
