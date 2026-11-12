import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSlashSuggestions,
  resolveSlashSuggestion,
  buildAtAssigneeSuggestions,
  buildNlDateTokens,
} from '../src/main';

const TODAY = '2026-06-01'; // fixed reference date for deterministic tests

// ── Natural-language /when command ──────────────────────────────────────

test('buildNlDateTokens expands a multi-field instruction', () => {
  const tokens = buildNlDateTokens('scheduled next week, start wednesday @ noon, due friday 2pm');
  assert.match(tokens, /⏳ \d{4}-\d{2}-\d{2}/, 'scheduled token');
  assert.match(tokens, /🛫 \d{4}-\d{2}-\d{2} 12:00/, 'start token w/ noon');
  assert.match(tokens, /📅 \d{4}-\d{2}-\d{2} 14:00/, 'due token w/ 2pm');
  // canonical order: scheduled, start, due
  assert.ok(tokens.indexOf('⏳') < tokens.indexOf('🛫'));
  assert.ok(tokens.indexOf('🛫') < tokens.indexOf('📅'));
});

test('/when slash query returns an echo suggestion that resolves to tokens', () => {
  const results = buildSlashSuggestions('/when due friday 2pm, start wednesday', TODAY);
  assert.equal(results.length, 1);
  assert.ok(results[0].startsWith('/when '));
  const resolved = resolveSlashSuggestion(results[0], TODAY);
  assert.match(resolved, /📅 \d{4}-\d{2}-\d{2} 14:00/);
  assert.match(resolved, /🛫 \d{4}-\d{2}-\d{2}/);
});

test('/when with no instruction yields a discoverability hint', () => {
  const results = buildSlashSuggestions('/when', TODAY);
  assert.equal(results.length, 1);
  assert.ok(results[0].startsWith('/when '));
});

test('partial /w surfaces the /when example for discoverability', () => {
  const results = buildSlashSuggestions('/w', TODAY);
  assert.ok(results.some((r) => r.startsWith('/when ')));
});

test('/due and /start results are not polluted by the /when hint', () => {
  assert.ok(buildSlashSuggestions('/due', TODAY).every((s) => s.startsWith('/due ')));
  assert.ok(buildSlashSuggestions('/start', TODAY).every((s) => s.startsWith('/start ')));
  assert.ok(buildSlashSuggestions('/done', TODAY).every((s) => s.startsWith('/done ')));
});

// ── buildSlashSuggestions ────────────────────────────────────────────────────

test('slash: bare / returns all suggestions', () => {
  const results = buildSlashSuggestions('/', TODAY);
  assert.ok(results.length > 20, `expected >20 suggestions, got ${results.length}`);
  assert.ok(results.some((s) => s.startsWith('/due')));
  assert.ok(results.some((s) => s.startsWith('/priority')));
  assert.ok(results.some((s) => s.startsWith('/repeat')));
  assert.ok(results.some((s) => s.startsWith('/done')));
});

test('slash: /due returns due-date suggestions only', () => {
  const results = buildSlashSuggestions('/due', TODAY);
  assert.ok(results.length > 0);
  assert.ok(results.every((s) => s.startsWith('/due ')), 'all results should start with /due');
  assert.ok(results.some((s) => s === '/due today'));
  assert.ok(results.some((s) => s === '/due tomorrow'));
  assert.ok(results.some((s) => s === '/due next week'));
});

test('slash: /sched returns scheduled-date suggestions', () => {
  const results = buildSlashSuggestions('/sched', TODAY);
  assert.ok(results.length > 0);
  assert.ok(results.every((s) => s.startsWith('/sched ')));
  assert.ok(results.some((s) => s === '/sched today'));
});

test('slash: /start returns start-date suggestions', () => {
  const results = buildSlashSuggestions('/start', TODAY);
  assert.ok(results.length > 0);
  assert.ok(results.every((s) => s.startsWith('/start ')));
});

test('slash: /priority returns exactly 5 priority options', () => {
  const results = buildSlashSuggestions('/priority', TODAY);
  assert.equal(results.length, 5);
  assert.ok(results.includes('/priority highest'));
  assert.ok(results.includes('/priority high'));
  assert.ok(results.includes('/priority medium'));
  assert.ok(results.includes('/priority low'));
  assert.ok(results.includes('/priority lowest'));
});

test('slash: /p also returns priority options', () => {
  // /p prefix matches /priority items
  const results = buildSlashSuggestions('/p', TODAY);
  assert.ok(results.some((s) => s.startsWith('/priority')));
});

test('slash: /repeat returns recurrence suggestions', () => {
  const results = buildSlashSuggestions('/repeat', TODAY);
  assert.ok(results.length > 0);
  assert.ok(results.every((s) => s.startsWith('/repeat ')));
  assert.ok(results.some((s) => s === '/repeat every day'));
  assert.ok(results.some((s) => s === '/repeat every week'));
  assert.ok(results.some((s) => s === '/repeat every month'));
});

test('slash: /done returns on-completion suggestions', () => {
  const results = buildSlashSuggestions('/done', TODAY);
  assert.ok(results.length > 0);
  assert.ok(results.every((s) => s.startsWith('/done ')));
  assert.ok(results.includes('/done keep'));
  assert.ok(results.includes('/done delete'));
  assert.ok(results.includes('/done archive'));
  assert.ok(results.includes('/done move-to-end'));
});

test('slash: /remind returns reminder suggestions', () => {
  const results = buildSlashSuggestions('/remind', TODAY);
  assert.ok(results.length > 0);
  assert.ok(results.every((s) => s.startsWith('/remind ')));
  assert.ok(results.some((s) => s.includes('09:00')));
});

test('slash: partial filter narrows results', () => {
  const high = buildSlashSuggestions('/priority h', TODAY);
  assert.ok(high.every((s) => s.startsWith('/priority h')));
  assert.ok(high.includes('/priority high'));
  assert.ok(high.includes('/priority highest'));
  assert.ok(!high.includes('/priority low'));
});

// ── resolveSlashSuggestion ───────────────────────────────────────────────────

test('resolve: /due today → 📅 <today>', () => {
  const result = resolveSlashSuggestion('/due today', TODAY);
  assert.equal(result, `📅 ${TODAY}`);
});

test('resolve: /sched tomorrow → ⏳ <tomorrow>', () => {
  const result = resolveSlashSuggestion('/sched tomorrow', TODAY);
  assert.equal(result, '⏳ 2026-06-02');
});

test('resolve: /start next week → 🛫 <next-week>', () => {
  const result = resolveSlashSuggestion('/start next week', TODAY);
  assert.match(result, /^🛫 \d{4}-\d{2}-\d{2}$/);
});

test('resolve: /remind today 09:00 → ⏰ <today> 09:00', () => {
  const result = resolveSlashSuggestion('/remind today 09:00', TODAY);
  assert.equal(result, `⏰ ${TODAY} 09:00`);
});

test('resolve: /priority highest → 🔺', () => {
  assert.equal(resolveSlashSuggestion('/priority highest', TODAY), '🔺');
});

test('resolve: /priority high → ⏫', () => {
  assert.equal(resolveSlashSuggestion('/priority high', TODAY), '⏫');
});

test('resolve: /priority medium → 🔼', () => {
  assert.equal(resolveSlashSuggestion('/priority medium', TODAY), '🔼');
});

test('resolve: /priority low → 🔽', () => {
  assert.equal(resolveSlashSuggestion('/priority low', TODAY), '🔽');
});

test('resolve: /priority lowest → ⏬', () => {
  assert.equal(resolveSlashSuggestion('/priority lowest', TODAY), '⏬');
});

test('resolve: /repeat every day → 🔁 every day', () => {
  assert.equal(resolveSlashSuggestion('/repeat every day', TODAY), '🔁 every day');
});

test('resolve: /repeat every week on Monday → 🔁 every week on Monday', () => {
  assert.equal(resolveSlashSuggestion('/repeat every week on Monday', TODAY), '🔁 every week on Monday');
});

test('resolve: /done delete → 🏁 delete', () => {
  assert.equal(resolveSlashSuggestion('/done delete', TODAY), '🏁 delete');
});

test('resolve: /done move-to-end → 🏁 move-to-end', () => {
  assert.equal(resolveSlashSuggestion('/done move-to-end', TODAY), '🏁 move-to-end');
});

// ── buildAtAssigneeSuggestions ───────────────────────────────────────────────

test('@ : bare @ with no known assignees → new-assignee hint', () => {
  const results = buildAtAssigneeSuggestions('@', []);
  assert.equal(results.length, 1);
  assert.ok(results[0].includes('new assignee'));
});

test('@ : bare @ with known assignees returns all sorted', () => {
  const results = buildAtAssigneeSuggestions('@', ['bob', 'alice', 'carol']);
  assert.deepEqual(results, ['@alice', '@bob', '@carol']);
});

test('@ : partial match filters by prefix', () => {
  const results = buildAtAssigneeSuggestions('@al', ['alice', 'alex', 'bob']);
  assert.ok(results.includes('@alice'));
  assert.ok(results.includes('@alex'));
  assert.ok(!results.includes('@bob'));
});

test('@ : no match shows hint with typed name', () => {
  const results = buildAtAssigneeSuggestions('@xyz', ['alice', 'bob']);
  assert.equal(results.length, 1);
  assert.ok(results[0].startsWith('@xyz'));
  assert.ok(results[0].includes('new assignee'));
});

test('@ : case-insensitive prefix match', () => {
  const results = buildAtAssigneeSuggestions('@AL', ['alice', 'alex', 'bob']);
  assert.ok(results.includes('@alice'));
  assert.ok(results.includes('@alex'));
});
