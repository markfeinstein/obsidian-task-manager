/**
 * Query Polish: Lint, Fix, and Explain features for task queries
 * Provides query validation, suggestions, and human-readable explanations
 */

import { Modal, App } from 'obsidian';
import { FocusManager, FocusTrap } from './keyboard-nav';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Levenshtein edit distance between two strings (used for typo suggestions). */
function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

/** Relative / structural tokens accepted in date-filter position. */
const DATE_RELATIVE_TOKENS = new Set([
  'today', 'tomorrow', 'yesterday', 'next-week', 'last-week',
  'next-month', 'last-month', 'before', 'after', 'on', 'in',
  'days', 'day', 'week', 'weeks', 'month', 'months',
]);

/**
 * Return `true` if `token` is an acceptable value in a date-filter expression.
 * ISO date strings are validated for calendar correctness.
 */
function isValidDateToken(token: string): boolean {
  if (DATE_RELATIVE_TOKENS.has(token.toLowerCase())) return true;
  if (/^\d+$/u.test(token)) return true; // plain numbers, e.g. "in 3 days"
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(token)) return false;
  const [y, mo, d] = token.split('-').map(Number);
  const date = new Date(y, mo - 1, d);
  return date.getFullYear() === y && date.getMonth() === mo - 1 && date.getDate() === d;
}

function parseLimitDirective(line: string): { value: number; target: 'tasks' | 'groups' } | null {
  const match = line.match(/^limit\s+(groups?\s+)?(?:to\s+)?(\d+)(?:\s+tasks?)?$/iu);
  if (!match) return null;
  return {
    value: Number.parseInt(match[2], 10),
    target: match[1] ? 'groups' : 'tasks',
  };
}

export interface QueryLintResult {
  isValid: boolean;
  errors: QueryError[];
  warnings: QueryWarning[];
  suggestions: QuerySuggestion[];
}

export interface QueryError {
  line: number;
  column: number;
  message: string;
  severity: 'error' | 'fatal';
  fix?: string;  // Suggested fix
  code: string;
}

export interface QueryWarning {
  line: number;
  column: number;
  message: string;
  severity: 'warning' | 'info';
  suggestion?: string;
  code: string;
}

export interface QuerySuggestion {
  type: 'performance' | 'clarity' | 'completeness';
  message: string;
  fix?: string;
}

/**
 * Query Linter - Validate and check queries for issues
 */
export class QueryLinter {
  private knownFilters = [
    'status', 'priority', 'due', 'scheduled', 'start', 'done', 'not done',
    'effort', 'actual', 'cost', 'variance',
    'tag', 'tags', 'has tag',
    'project', 'team', 'file', 'path',
    'assignee', 'reviewer',
    'created', 'completed', 'cancelled', 'canceled', 'reminder', 'happens', 'follow-up', 'follow up', 'followup',
    'recurring', 'recurrence', 'is recurring',
    'blocked', 'blocks', 'is blocked',
    'group by', 'sort by', 'limit', 'view', 'view:', 'style', 'style:',
  ];

  private knownOperators = [
    'is', 'has', 'no',
    'where', 'filter',
    'and', 'or', 'not',
    'order', 'asc', 'desc',
    'by',
    'recursive', 'tree',
    'flatten', 'rollup',
    'show', 'hide', 'shows', 'hides',
  ];

  private knownSorts = [
    'smart', 'urgency', 'status', 'status.name', 'status.type', 'status.symbol', 'next-status.symbol',
    'id', 'due', 'scheduled', 'start', 'done', 'created', 'cancelled', 'canceled', 'reminder', 'happens', 'follow-up', 'followup',
    'description', 'description-without-tags', 'text', 'title', 'priority', 'recurring', 'recurrence', 'on-completion', 'depends-on',
    'tag', 'tags', 'original-markdown', 'line-number', 'line', 'random', 'path', 'root', 'folder', 'filename', 'file', 'heading', 'backlink',
    'effort', 'estimate', 'actual', 'cost', 'pinned', 'pin', 'context', 'dependency-order',
    'assignee', 'reviewer', 'project', 'team', 'series', 'recurrence-series',
  ];

  private knownGroupers = [
    ...this.knownSorts,
  ];

  /** All keywords eligible for typo-suggestion. */
  private allKeywords = Array.from(new Set([
    ...this.knownFilters.flatMap((filter) => filter.split(/\s+/u)),
    ...this.knownOperators,
    'sort', 'group',
  ]));

  /** Return known keywords within edit-distance 1 of `word`. */
  private findSimilarKeywords(word: string): string[] {
    return this.allKeywords.filter((kw) => editDistance(word.toLowerCase(), kw) <= 1);
  }

  /**
   * Lint a query and return issues
   */
  lint(query: string): QueryLintResult {
    const errors: QueryError[] = [];
    const warnings: QueryWarning[] = [];
    const suggestions: QuerySuggestion[] = [];

    const lines = query.split('\n');

    // Check for empty query
    if (!query.trim()) {
      return {
        isValid: false,
        errors: [
          {
            line: 1,
            column: 1,
            message: 'Query is empty',
            severity: 'error',
            code: 'EMPTY_QUERY',
          },
        ],
        warnings: [],
        suggestions: [],
      };
    }

    // Parse and validate each clause
    let groupDepth = 0;
    const filtersSeen = new Map<string, number>(); // exact line → first line number
    const DATE_PREFIX_FILTERS = new Set([
      'due', 'scheduled', 'start', 'done', 'created', 'completed',
      'cancelled', 'canceled', 'reminder', 'happens', 'follow-up', 'follow up', 'followup',
    ]);

    lines.forEach((line, lineNum) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('//')) return;  // Skip empty and comments

      // Track grouping
      groupDepth += (trimmed.match(/\(/gu) || []).length;
      groupDepth -= (trimmed.match(/\)/gu) || []).length;

      const tokens = trimmed.split(/\s+/u);
      const lowerTokens = tokens.map((token) => token.toLowerCase());

      // Validate known keywords (with typo-detection)
      if (tokens[0]) {
        if (!this.isValidKeyword(tokens[0])) {
          const similar = this.findSimilarKeywords(tokens[0]);
          if (similar.length > 0) {
            warnings.push({
              line: lineNum + 1,
              column: 1,
              message: `Unknown keyword "${tokens[0]}". Did you mean: ${similar.join(', ')}?`,
              severity: 'warning',
              suggestion: similar[0],
              code: 'UNKNOWN_KEYWORD_TYPO',
            });
          } else {
            warnings.push({
              line: lineNum + 1,
              column: 1,
              message: `Unknown keyword: "${tokens[0]}"`,
              severity: 'warning',
              code: 'UNKNOWN_KEYWORD',
            });
          }
        }
      }

      // Check for common mistakes
      if (trimmed.includes('==')) {
        warnings.push({
          line: lineNum + 1,
          column: trimmed.indexOf('==') + 1,
          message: 'Use single "=" for filters, not "=="',
          severity: 'warning',
          suggestion: 'Change "==" to "="',
          code: 'INVALID_OPERATOR',
        });
      }

      // Validate filter syntax
      if (lowerTokens[0] === 'priority' || lowerTokens[0] === 'status') {
        if (tokens.length < 2) {
          errors.push({
            line: lineNum + 1,
            column: 1,
            message: `"${tokens[0]}" filter requires a value`,
            severity: 'error',
            code: 'MISSING_FILTER_VALUE',
          });
        }
      }

      // Validate date tokens in date-prefix filters
      const datePrefix = lowerTokens[0] === 'follow' && lowerTokens[1] === 'up'
        ? 'follow up'
        : (tokens[0] ?? '').toLowerCase();
      if (DATE_PREFIX_FILTERS.has(datePrefix)) {
        for (let i = 1; i < tokens.length; i++) {
          // Only validate tokens that look like ISO dates but may be malformed
          if (/^\d{4}-\d{2}-\d{2}$/u.test(tokens[i]) && !isValidDateToken(tokens[i])) {
            errors.push({
              line: lineNum + 1,
              column: trimmed.indexOf(tokens[i]) + 1,
              message: `Invalid date "${tokens[i]}" — day or month out of range`,
              severity: 'error',
              code: 'INVALID_DATE',
            });
          }
        }
      }

      // Check for incomplete group by
      if (lowerTokens[0] === 'group' && lowerTokens[1] === 'by') {
        if (tokens.length < 3) {
          errors.push({
            line: lineNum + 1,
            column: 1,
            message: '"group by" requires a field',
            severity: 'error',
            fix: 'group by status',
            code: 'INCOMPLETE_GROUP_BY',
          });
        } else if (!this.knownGroupers.includes(lowerTokens[2])) {
          warnings.push({
            line: lineNum + 1,
            column: 1,
            message: `"${tokens[2]}" may not be a valid grouping field`,
            severity: 'warning',
            code: 'UNKNOWN_GROUP_FIELD',
          });
        }
      }

      // Check for incomplete sort by
      if (lowerTokens[0] === 'sort' && lowerTokens[1] === 'by') {
        if (tokens.length < 3) {
          errors.push({
            line: lineNum + 1,
            column: 1,
            message: '"sort by" requires a field',
            severity: 'error',
            fix: 'sort by priority',
            code: 'INCOMPLETE_SORT_BY',
          });
        } else if (!this.knownSorts.includes(lowerTokens[2])) {
          warnings.push({
            line: lineNum + 1,
            column: 1,
            message: `"${tokens[2]}" may not be a sortable field`,
            severity: 'warning',
            code: 'UNKNOWN_SORT_FIELD',
          });
        }
      }

      // Detect duplicate (redundant) filter lines
      const skipDedupe = new Set(['sort', 'group', 'limit', 'where', 'filter', 'and', 'or']);
      if (tokens[0] && !skipDedupe.has(tokens[0].toLowerCase())) {
        if (filtersSeen.has(trimmed)) {
          warnings.push({
            line: lineNum + 1,
            column: 1,
            message: `Redundant filter: "${trimmed}" duplicates line ${filtersSeen.get(trimmed)}`,
            severity: 'warning',
            code: 'REDUNDANT_FILTER',
          });
        } else {
          filtersSeen.set(trimmed, lineNum + 1);
        }
      }
    });

    // Check for unbalanced parentheses
    if (groupDepth !== 0) {
      errors.push({
        line: lines.length,
        column: 1,
        message: 'Unbalanced parentheses',
        severity: 'fatal',
        code: 'UNBALANCED_PARENS',
      });
    }

    // Performance suggestions
    if (query.length > 1000) {
      suggestions.push({
        type: 'performance',
        message: 'Long queries may be slow. Consider breaking into multiple views.',
      });
    }

    const hasSortBy   = /\bsort\s+by\b/iu.test(query);
    const hasDateBound = /\b(?:due|created|completed)\s+(?:before|after|on|in)\b/iu.test(query);
    const hasLimit    = /\blimit\b/iu.test(query);

    if (hasSortBy && !hasLimit && !hasDateBound) {
      suggestions.push({
        type: 'performance',
        message: 'Query has a sort but no limit and no date bounds — consider adding "limit N" to cap result size.',
        fix: 'Add: limit 50',
      });
    } else if (!hasLimit) {
      suggestions.push({
        type: 'completeness',
        message: 'Consider adding a "limit" clause to show the most important results.',
        fix: 'Add: limit 50',
      });
    }

    // Clarity suggestions
    if (query.match(/status\s+(done|not\s+done)/iu) && query.match(/priority/iu)) {
      suggestions.push({
        type: 'clarity',
        message: 'Consider grouping by status first for better readability.',
        fix: 'Add "group by status" after other filters',
      });
    }

    const isValid = errors.length === 0;

    return {
      isValid,
      errors,
      warnings,
      suggestions,
    };
  }

  /**
   * Auto-fix common query issues
   */
  fix(query: string): string {
    let fixed = query;

    // Fix == to =
    fixed = fixed.replace(/==/g, '=');

    // Fix common typos
    fixed = fixed.replace(/\bstatu\b/gi, 'status');
    fixed = fixed.replace(/\bpriorty\b/gi, 'priority');
    fixed = fixed.replace(/\bdue_date\b/gi, 'due');

    // Fix spacing issues — collapse runs of horizontal whitespace (spaces/tabs) within
    // each line to a single space, but leave newlines intact so the clause-per-line
    // structure that the linter (and the query parser) relies on is preserved.
    fixed = fixed.replace(/[^\S\n]+/g, ' ');  // Multiple spaces/tabs to single (preserve newlines)

    // Add missing "by" in sort/group
    fixed = fixed.replace(/^(\s*)sort\s+(?!by)([a-zA-Z]+)/gmi, '$1sort by $2');
    fixed = fixed.replace(/^(\s*)group\s+(?!by)([a-zA-Z]+)/gmi, '$1group by $2');

    return fixed.trim();
  }

  private isValidKeyword(word: string): boolean {
    return this.allKeywords.includes(word.toLowerCase());
  }
}

/**
 * Query Explainer - Provide human-readable explanations
 */
export class QueryExplainer {
  /**
   * Generate a human-readable explanation of a query
   */
  explain(query: string): string {
    const lines = query.split('\n').filter((l) => l.trim() && !l.trim().startsWith('//'));

    const filterLines: string[] = [];
    const sortLines: string[] = [];
    const groupLines: string[] = [];
    let limitValue: number | null = null;
    let limitTarget: 'tasks' | 'groups' = 'tasks';

    for (const line of lines) {
      const trimmed = line.trim();
      const tokens = trimmed.split(/\s+/u);
      const lowerTokens = tokens.map((token) => token.toLowerCase());
      const limitDirective = parseLimitDirective(trimmed);

      if (lowerTokens[0] === 'sort' && lowerTokens[1] === 'by') {
        const dir = tokens[3]?.match(/^(asc|desc)$/iu) ? ` (${tokens[3].toLowerCase()})` : '';
        sortLines.push(`\`${trimmed}\`` + (dir ? ` — ${dir.trim()}` : ''));
      } else if (lowerTokens[0] === 'group' && lowerTokens[1] === 'by') {
        groupLines.push(`\`${trimmed}\``);
      } else if (limitDirective) {
        limitValue = limitDirective.value;
        limitTarget = limitDirective.target;
      } else if (trimmed) {
        filterLines.push(`\`${trimmed}\``);
      }
    }

    let out = 'This query will:\n\n';

    if (filterLines.length > 0) {
      out += '#### Active Filters\n';
      filterLines.forEach((f) => { out += `- ${f}\n`; });
      out += '\n';
    }

    if (sortLines.length > 0) {
      out += '#### Sort Order\n';
      sortLines.forEach((s) => { out += `- ${s}\n`; });
      out += '\n';
    }

    if (groupLines.length > 0) {
      out += '#### Grouping\n';
      groupLines.forEach((g) => { out += `- ${g}\n`; });
      out += '\n';
    }

    if (limitValue !== null) {
      out += '#### Layout Options\n';
      const limitDirective = limitTarget === 'groups' ? `limit groups ${String(limitValue)}` : `limit ${String(limitValue)}`;
      out += `- \`${limitDirective}\` — Limit to ${String(limitValue)} ${limitTarget}\n\n`;
    }

    if (
      filterLines.length === 0 &&
      sortLines.length === 0 &&
      groupLines.length === 0 &&
      limitValue === null
    ) {
      out += '_No directives found — all tasks will be shown._\n\n';
    }

    // Summary sentence
    out += '**Result:** ';
    if (limitValue !== null) {
      out += `Up to ${String(limitValue)} ${limitTarget}`;
    } else {
      out += 'All matching tasks';
    }
    if (groupLines.length > 0) out += ', grouped';
    if (sortLines.length > 0)  out += ', sorted';
    out += '.';

    return out;
  }
}

/**
 * Parse common natural-language phrases into task query DSL lines.
 *
 * Returns the original text unchanged if no shortcut matches.
 * Caller is responsible for splitting multi-line input before calling.
 *
 * @example
 * parseNaturalLanguageQuery('due today')   // => 'due on today'
 * parseNaturalLanguageQuery('high priority') // => 'priority is high'
 */
export function parseNaturalLanguageQuery(text: string): string {
  const trimmed = text.trim();
  type Replacement = string | ((m: RegExpMatchArray) => string);
  const shortcuts: Array<{ pattern: RegExp; result: Replacement }> = [
    // Completion status
    { pattern: /^not\s+done$/iu,              result: 'status.type is not DONE' },
    { pattern: /^incomplete$/iu,              result: 'status.type is not DONE' },
    { pattern: /^completed?$/iu,              result: 'status.type is DONE' },
    { pattern: /^on\s+hold$/iu,               result: 'status.type is ON_HOLD' },
    // Priority
    { pattern: /^high\s+priority$/iu,         result: 'priority is high' },
    { pattern: /^urgent(ly)?$/iu,             result: 'priority is urgent' },
    { pattern: /^low\s+priority$/iu,          result: 'priority is low' },
    { pattern: /^medium\s+priority$/iu,       result: 'priority is medium' },
    // Due dates
    { pattern: /^due\s+today$/iu,             result: 'due on today' },
    { pattern: /^due\s+tomorrow$/iu,          result: 'due on tomorrow' },
    { pattern: /^due\s+next\s+week$/iu,       result: 'due after today\ndue before next week' },
    { pattern: /^overdue$/iu,                 result: 'due before today' },
    { pattern: /^no\s+due\s+date$/iu,         result: 'no due date' },
    // Tags
    { pattern: /^tagged\s+#?(\S+)$/iu,        result: (m) => `tag includes #${m[1].replace(/^#/u, '')}` },
    { pattern: /^has\s+tag\s+#?(\S+)$/iu,     result: (m) => `tag includes #${m[1].replace(/^#/u, '')}` },
    // Project metadata
    { pattern: /^in\s+project\s+(.+)$/iu,     result: (m) => `project includes ${m[1]}` },
    { pattern: /^project\s+(.+)$/iu,          result: (m) => `project includes ${m[1]}` },
    // Assignee
    { pattern: /^assigned\s+to\s+(.+)$/iu,   result: (m) => `assignee is ${m[1]}` },
    // Recurrence
    { pattern: /^recurring$/iu,               result: 'is recurring' },
    { pattern: /^not\s+recurring$/iu,         result: 'is not recurring' },
  ];

  for (const { pattern, result } of shortcuts) {
    const match = trimmed.match(pattern);
    if (match) {
      return typeof result === 'function' ? result(match) : result;
    }
  }

  // No shortcut matched — return as-is
  return trimmed;
}

/**
 * Query Editor Modal with linting and suggestions
 */
export class QueryEditorModal extends Modal {
  private query: string = '';
  private onSave: (query: string) => void = () => {};
  private linter = new QueryLinter();
  private explainer = new QueryExplainer();
  private focusTrap: FocusTrap | null = null;
  private focusManager = new FocusManager();

  constructor(app: App, initialQuery: string = '') {
    super(app);
    this.query = initialQuery;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.setAttr('role', 'dialog');
    contentEl.setAttr('aria-modal', 'true');

    const title = contentEl.createEl('h2', { text: 'Query Editor' });
    title.id = 'task-manager-query-editor-title';
    contentEl.setAttr('aria-labelledby', title.id);

    // Textarea for query
    const textarea = contentEl.createEl('textarea', {
      attr: { rows: '10', class: 'query-editor-textarea' },
    });
    textarea.value = this.query;
    textarea.addEventListener('input', (e) => {
      this.query = (e.target as HTMLTextAreaElement).value;
      this.updateLinting();
    });

    // Linting results
    const _lintingDiv = contentEl.createDiv('query-linting');
    this.updateLinting();

    // Buttons
    const buttonDiv = contentEl.createDiv('query-editor-buttons');

    buttonDiv.createEl('button', { text: 'Explain', cls: 'mod-secondary' }).addEventListener('click', () => {
      this.showExplanation();
    });

    buttonDiv.createEl('button', { text: 'Auto-fix', cls: 'mod-secondary' }).addEventListener('click', () => {
      this.query = this.linter.fix(this.query);
      textarea.value = this.query;
      this.updateLinting();
    });

    buttonDiv.createEl('button', { text: 'Save', cls: 'mod-cta' }).addEventListener('click', () => {
      this.onSave(this.query);
      this.close();
    });

    buttonDiv.createEl('button', { text: 'Cancel', cls: 'mod-warning' }).addEventListener('click', () => {
      this.close();
    });

    this.focusTrap = new FocusTrap(contentEl);
    this.focusManager.focus(textarea);
  }

  onClose(): void {
    this.focusTrap?.destroy();
    this.focusTrap = null;
    this.focusManager.restoreFocus();
    this.contentEl.empty();
  }

  private updateLinting(): void {
    const lintingDiv = this.contentEl.querySelector('.query-linting') as HTMLElement;
    if (!lintingDiv) return;

    lintingDiv.empty();
    const result = this.linter.lint(this.query);

    // Errors
    if (result.errors.length > 0) {
      const errorDiv = lintingDiv.createDiv('query-errors');
      errorDiv.createEl('h3', { text: '❌ Errors' });
      result.errors.forEach((err) => {
        const errItem = errorDiv.createDiv('query-error-item');
        errItem.createEl('strong', { text: err.message });
        if (err.fix) {
          errItem.createEl('br');
          errItem.createEl('code', { text: err.fix });
        }
      });
    }

    // Warnings
    if (result.warnings.length > 0) {
      const warningDiv = lintingDiv.createDiv('query-warnings');
      warningDiv.createEl('h3', { text: '⚠️ Warnings' });
      result.warnings.forEach((warn) => {
        const warnItem = warningDiv.createDiv('query-warning-item');
        warnItem.createEl('span', { text: warn.message });
      });
    }

    // Suggestions
    if (result.suggestions.length > 0) {
      const suggestionDiv = lintingDiv.createDiv('query-suggestions');
      suggestionDiv.createEl('h3', { text: '💡 Suggestions' });
      result.suggestions.forEach((sugg) => {
        const suggItem = suggestionDiv.createDiv('query-suggestion-item');
        suggItem.createEl('span', { text: sugg.message });
      });
    }

    if (result.isValid && result.suggestions.length === 0) {
      lintingDiv.createDiv('query-valid').createEl('span', { text: '✓ Query is valid' });
    }
  }

  private showExplanation(): void {
    const explanation = this.explainer.explain(this.query);
    const modal = new Modal(this.app);
    const focusManager = new FocusManager();
    let focusTrap: FocusTrap | null = null;

    modal.contentEl.setAttr('role', 'dialog');
    modal.contentEl.setAttr('aria-modal', 'true');
    const title = modal.contentEl.createEl('h2', { text: 'Query Explanation' });
    title.id = 'task-manager-query-explanation-title';
    modal.contentEl.setAttr('aria-labelledby', title.id);
    modal.contentEl.createEl('pre', { text: explanation });
    const closeButton = modal.contentEl.createEl('button', { text: 'Close', cls: 'mod-cta' });
    closeButton.addEventListener('click', () => {
      modal.close();
    });
    modal.onClose = () => {
      focusTrap?.destroy();
      focusTrap = null;
      focusManager.restoreFocus();
      modal.contentEl.empty();
    };

    modal.open();
    focusTrap = new FocusTrap(modal.contentEl);
    focusManager.focus(closeButton);
  }

  setOnSave(callback: (query: string) => void): void {
    this.onSave = callback;
  }
}
