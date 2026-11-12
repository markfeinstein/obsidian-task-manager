import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generateTaskCaptureURI,
  isSafeTaskCallbackUrl,
  isSafeTaskCallbackUrlForRequest,
  MobileURIHandler,
  parseTaskURI,
  type SafeTaskCallbackRequest,
  type SafeTaskCallbackTransport,
} from '../src/mobile-uri-capture';
import type { HostnameResolver } from '../src/url-safety';
import { parseMarkdownTaskLine } from '../src/task-model';

const publicHostnameResolver: HostnameResolver = async () => ['93.184.216.34'];
const privateHostnameResolver: HostnameResolver = async () => ['127.0.0.1'];
const mixedHostnameResolver: HostnameResolver = async () => ['93.184.216.34', '127.0.0.1'];

function captureCallbackTransport(capture: { request?: SafeTaskCallbackRequest; called?: boolean }): SafeTaskCallbackTransport {
  return async (request) => {
    capture.called = true;
    capture.request = request;
  };
}

// ── parseTaskURI — basic actions ─────────────────────────────────────────────

test('parseTaskURI: parses obsidian quick-capture params', () => {
  const parsed = parseTaskURI('obsidian://quick-capture?title=Buy+milk&tags=errands,home&due=tomorrow');
  assert.ok(parsed);
  assert.equal(parsed.action, 'quick-capture');
  assert.equal(parsed.params.title, 'Buy milk');
  assert.deepEqual(parsed.params.tags, ['errands', 'home']);
  assert.equal(parsed.params.due, 'tomorrow');
});

test('parseTaskURI: parses add-task action', () => {
  const parsed = parseTaskURI('obsidian://add-task?title=Finish+report&priority=high&project=Work');
  assert.ok(parsed);
  assert.equal(parsed.scheme, 'obsidian');
  assert.equal(parsed.action, 'add-task');
  assert.equal(parsed.params.priority, 'high');
  assert.equal(parsed.params.project, 'Work');
});

test('parseTaskURI: parses schedule-task action', () => {
  const parsed = parseTaskURI('obsidian://schedule-task?title=Review&due=2026-06-01');
  assert.ok(parsed);
  assert.equal(parsed.action, 'schedule-task');
  assert.equal(parsed.params.due, '2026-06-01');
});

test('parseTaskURI: parses focus-note action', () => {
  const parsed = parseTaskURI('obsidian://focus-note?file=Projects%2FMyProject.md');
  assert.ok(parsed);
  assert.equal(parsed.action, 'focus-note');
  assert.equal(parsed.params.file, 'Projects/MyProject.md');
});

test('parseTaskURI: parses vault parameter', () => {
  const parsed = parseTaskURI('obsidian://add-task?title=Task&vault=MyVault');
  assert.ok(parsed);
  assert.equal(parsed.params.vault, 'MyVault');
});

test('parseTaskURI: returns null for unsupported obsidian actions', () => {
  assert.equal(parseTaskURI('obsidian://unsupported?action=x'), null);
});

test('parseTaskURI: returns null for empty string', () => {
  assert.equal(parseTaskURI(''), null);
});

test('parseTaskURI: returns null for garbage input', () => {
  assert.equal(parseTaskURI('not-a-uri-at-all!!!'), null);
});

test('parseTaskURI: ignores invalid priority value', () => {
  const parsed = parseTaskURI('obsidian://add-task?title=Task&priority=critical');
  assert.ok(parsed);
  assert.equal(parsed.params.priority, undefined);
});

test('parseTaskURI: parses all four valid priority values', () => {
  for (const p of ['low', 'medium', 'high', 'urgent'] as const) {
    const parsed = parseTaskURI(`obsidian://add-task?title=T&priority=${p}`);
    assert.ok(parsed, `should parse priority ${p}`);
    assert.equal(parsed.params.priority, p);
  }
});

test('parseTaskURI: parses description parameter', () => {
  const parsed = parseTaskURI('obsidian://quick-capture?title=T&description=Details+here');
  assert.ok(parsed);
  assert.equal(parsed.params.description, 'Details here');
});

test('parseTaskURI: trims comma-separated tags and drops empty tag entries', () => {
  const parsed = parseTaskURI('obsidian://quick-capture?title=T&tags=work,%20urgent,,%20home%20');
  assert.ok(parsed);
  assert.deepEqual(parsed.params.tags, ['work', 'urgent', 'home']);
});

// ── parseTaskURI — http/https ────────────────────────────────────────────────

test('parseTaskURI: parses https URI with task-action param', () => {
  const parsed = parseTaskURI(
    'https://tasks.example.com/capture?task-action=add-task&title=Web+Task&priority=medium'
  );
  assert.ok(parsed);
  assert.equal(parsed.scheme, 'https');
  assert.equal(parsed.action, 'add-task');
  assert.equal(parsed.params.title, 'Web Task');
  assert.equal(parsed.params.priority, 'medium');
});

test('parseTaskURI: returns null for https URI without task-action param', () => {
  assert.equal(parseTaskURI('https://example.com/page'), null);
});

test('parseTaskURI: returns null for http URI with unsupported task-action', () => {
  assert.equal(parseTaskURI('http://x.com/y?task-action=delete-all'), null);
});

test('parseTaskURI: parses web-only metadata params', () => {
  const parsed = parseTaskURI(
    'https://tasks.example.com/capture?task-action=focus-note&file=Projects%2FPlan.md&vault=Work&callback=https%3A%2F%2Fexample.com%2Fdone'
  );
  assert.ok(parsed);
  assert.equal(parsed.action, 'focus-note');
  assert.equal(parsed.params.file, 'Projects/Plan.md');
  assert.equal(parsed.params.vault, 'Work');
  assert.equal(parsed.params.callback, 'https://example.com/done');
});

// ── generateTaskCaptureURI ───────────────────────────────────────────────────

test('generateTaskCaptureURI: round-trips task params', () => {
  const uri = generateTaskCaptureURI('add-task', {
    title: 'Write report',
    priority: 'high',
    tags: ['work', 'writing'],
  });
  const parsed = parseTaskURI(uri);
  assert.ok(parsed);
  assert.equal(parsed.action, 'add-task');
  assert.equal(parsed.params.title, 'Write report');
  assert.equal(parsed.params.priority, 'high');
  assert.deepEqual(parsed.params.tags, ['work', 'writing']);
});

test('generateTaskCaptureURI: no params produces bare obsidian:// URI', () => {
  const uri = generateTaskCaptureURI('quick-capture');
  assert.equal(uri, 'obsidian://quick-capture');
});

test('generateTaskCaptureURI: focus-note action includes file param', () => {
  const uri = generateTaskCaptureURI('focus-note', { file: 'Notes/Daily.md' });
  const parsed = parseTaskURI(uri);
  assert.ok(parsed);
  assert.equal(parsed.params.file, 'Notes/Daily.md');
});

test('generateTaskCaptureURI: tags round-trip with comma-separated values', () => {
  const uri = generateTaskCaptureURI('add-task', { tags: ['alpha', 'beta', 'gamma'] });
  const parsed = parseTaskURI(uri);
  assert.ok(parsed);
  assert.deepEqual(parsed.params.tags, ['alpha', 'beta', 'gamma']);
});

// ── isSafeTaskCallbackUrl ────────────────────────────────────────────────────

test('isSafeTaskCallbackUrl: allows non-local HTTPS callbacks', () => {
  assert.equal(isSafeTaskCallbackUrl('https://example.com/hook'), true);
});

test('isSafeTaskCallbackUrl: allows DNS names that look like IPv6 private prefixes', () => {
  assert.equal(isSafeTaskCallbackUrl('https://fd.example.com/hook'), true);
  assert.equal(isSafeTaskCallbackUrl('https://fe80.example.com/hook'), true);
});

test('isSafeTaskCallbackUrl: blocks plain HTTP', () => {
  assert.equal(isSafeTaskCallbackUrl('http://example.com/hook'), false);
});

test('isSafeTaskCallbackUrl: blocks localhost', () => {
  assert.equal(isSafeTaskCallbackUrl('https://localhost/hook'), false);
});

test('isSafeTaskCallbackUrl: blocks 192.168.x.x', () => {
  assert.equal(isSafeTaskCallbackUrl('https://192.168.1.10/hook'), false);
});

test('isSafeTaskCallbackUrl: blocks 10.x.x.x', () => {
  assert.equal(isSafeTaskCallbackUrl('https://10.0.0.2/hook'), false);
});

test('isSafeTaskCallbackUrl: blocks 0.x.x.x current-network addresses', () => {
  assert.equal(isSafeTaskCallbackUrl('https://0.1.2.3/hook'), false);
});

test('isSafeTaskCallbackUrl: blocks CGNAT range 100.64.x.x', () => {
  assert.equal(isSafeTaskCallbackUrl('https://100.64.0.1/hook'), false);
});

test('isSafeTaskCallbackUrl: blocks IPv6 loopback ::1', () => {
  assert.equal(isSafeTaskCallbackUrl('https://[::1]/hook'), false);
});

test('isSafeTaskCallbackUrl: blocks IPv6 unspecified ::', () => {
  assert.equal(isSafeTaskCallbackUrl('https://[::]/hook'), false);
});

test('isSafeTaskCallbackUrl: blocks 127.x.x.x', () => {
  assert.equal(isSafeTaskCallbackUrl('https://127.0.0.1/hook'), false);
});

test('isSafeTaskCallbackUrl: blocks IPv4-mapped IPv6 loopback', () => {
  assert.equal(isSafeTaskCallbackUrl('https://[::ffff:127.0.0.1]/hook'), false);
});

test('isSafeTaskCallbackUrl: blocks IPv4-mapped IPv6 private addresses', () => {
  assert.equal(isSafeTaskCallbackUrl('https://[::ffff:192.168.1.10]/hook'), false);
});

test('isSafeTaskCallbackUrl: blocks hex IPv4-mapped IPv6 private addresses', () => {
  assert.equal(isSafeTaskCallbackUrl('https://[::ffff:c0a8:010a]/hook'), false);
});

test('isSafeTaskCallbackUrl: blocks malformed URL', () => {
  assert.equal(isSafeTaskCallbackUrl('not-a-url'), false);
});

test('isSafeTaskCallbackUrlForRequest: blocks hostnames resolving to private addresses', async () => {
  assert.equal(await isSafeTaskCallbackUrlForRequest('https://public.example/done', privateHostnameResolver), false);
  assert.equal(await isSafeTaskCallbackUrlForRequest('https://public.example/done', publicHostnameResolver), true);
});

test('isSafeTaskCallbackUrlForRequest: rejects DNS-unavailable fallback', async () => {
  const dnsUnavailableResolver: HostnameResolver = async () => null;
  assert.equal(await isSafeTaskCallbackUrlForRequest('https://public.example/done', dnsUnavailableResolver), false);
});

test('isSafeTaskCallbackUrlForRequest: rejects mixed public and private DNS answers', async () => {
  assert.equal(await isSafeTaskCallbackUrlForRequest('https://public.example/done', mixedHostnameResolver), false);
});

// ── MobileURIHandler ─────────────────────────────────────────────────────────

test('MobileURIHandler: schedule-task appends due-date emoji metadata', async () => {
  const captured: string[] = [];
  const handler = new MobileURIHandler({} as any, async (task) => { captured.push(task); });
  await handler.handleCaptureURI('obsidian://schedule-task?title=Call+Dentist&due=2026-05-29');
  assert.deepEqual(captured, ['Call Dentist 📅 2026-05-29']);
});

test('MobileURIHandler: rejects vault mismatches before creating tasks', async () => {
  const captured: string[] = [];
  const handler = new MobileURIHandler({
    vault: {
      getName: () => 'Work',
    },
    workspace: {
      getLeaf: () => { throw new Error('should not open file for mismatched vault'); },
    },
  } as any, async (task) => { captured.push(task); });

  await handler.handleCaptureURI('obsidian://quick-capture?vault=Personal&title=Ping');
  assert.deepEqual(captured, []);
});

test('MobileURIHandler: production mode requires enablement, vault, secret, and supported parameters', async () => {
  const captured: string[] = [];
  let enabled = false;
  const handler = new MobileURIHandler(
    { vault: { getName: () => 'Work' } } as never,
    async (task) => { captured.push(task); },
    undefined,
    undefined,
    () => enabled,
    true,
    () => 'shared-secret',
  );
  await handler.handleCaptureURI('obsidian://add-task?vault=Work&secret=shared-secret&title=Disabled');
  enabled = true;
  await handler.handleCaptureURI('obsidian://add-task?vault=Work&title=Missing+secret');
  await handler.handleCaptureURI('obsidian://add-task?vault=Work&secret=shared-secret&file=Other.md&title=Wrong+target');
  await handler.handleCaptureURI('obsidian://add-task?vault=Work&secret=shared-secret&title=Allowed');
  assert.deepEqual(captured, ['Allowed']);
});

test('MobileURIHandler: schedule-task rejects impossible ISO dates', async () => {
  const captured: string[] = [];
  const handler = new MobileURIHandler({} as any, async (task) => { captured.push(task); });
  await handler.handleCaptureURI('obsidian://schedule-task?title=Impossible&due=2026-02-31');
  assert.deepEqual(captured, []);
});

test('MobileURIHandler: schedule-task rejects ambiguous locale dates', async () => {
  const captured: string[] = [];
  const handler = new MobileURIHandler({} as any, async (task) => { captured.push(task); });
  await handler.handleCaptureURI('obsidian://schedule-task?title=Ambiguous&due=06%2F07%2F2026');
  assert.deepEqual(captured, []);
});

test('MobileURIHandler: schedule-task keeps due metadata with description', async () => {
  const captured: string[] = [];
  const handler = new MobileURIHandler({} as any, async (task) => { captured.push(task); });
  await handler.handleCaptureURI('obsidian://schedule-task?title=Call+Dentist&description=Ask+about+forms&due=2026-05-29');
  assert.deepEqual(captured, ['Call Dentist 📅 2026-05-29\nAsk about forms']);
});

test('MobileURIHandler: quick-capture creates task from title', async () => {
  const captured: string[] = [];
  const handler = new MobileURIHandler({} as any, async (task) => { captured.push(task); });
  await handler.handleCaptureURI('obsidian://quick-capture?title=Buy+groceries');
  assert.deepEqual(captured, ['Buy groceries']);
});

test('MobileURIHandler: add-task creates task from title', async () => {
  const captured: string[] = [];
  const handler = new MobileURIHandler({} as any, async (task) => { captured.push(task); });
  await handler.handleCaptureURI('obsidian://add-task?title=Write+docs');
  assert.deepEqual(captured, ['Write docs']);
});

test('MobileURIHandler: add-task applies parsed metadata fields', async () => {
  const captured: string[] = [];
  const handler = new MobileURIHandler({} as any, async (task) => { captured.push(task); });
  await handler.handleCaptureURI('obsidian://add-task?title=Write+docs&description=Include+screenshots&due=2026-06-01&priority=high&project=Docs&tags=work,%23urgent');
  assert.deepEqual(captured, ['Write docs ⏫ 📅 2026-06-01 [project:: Docs] #work #urgent\nInclude screenshots']);
});

test('MobileURIHandler: strips injected inline metadata from URI task fields', async () => {
  const captured: string[] = [];
  const handler = new MobileURIHandler({} as never, async (task) => { captured.push(task); });
  await handler.handleCaptureURI('obsidian://add-task?title=Write%20docs%20%F0%9F%86%94%20evil_id%20%F0%9F%93%85%202099-01-01%20%F0%9F%94%81%20every%20day%20%5Bid::%20ms-todo:123%5D&description=-%20%5B%20%5D%20Injected%20child%20%F0%9F%93%85%202099-01-01%20%5Bid::%20todoist:evil%5D&project=Docs%5D%20%5Bid::%20google-tasks:evil%5D&tags=work%5D%20%5Bid::%20bad%5D,%23urgent');
  assert.deepEqual(captured, ['Write docs [project:: Docs] #work #urgent\nInjected child']);
  assert.doesNotMatch(captured[0], /\[id::|🆔|📅|🔁/u);
  const parsed = parseMarkdownTaskLine(`- [ ] ${captured[0].split('\n')[0]}`, 'Inbox.md', 1);
  assert.equal(parsed?.metadata.id, undefined);
  assert.equal(parsed?.metadata.dates.due, undefined);
  assert.equal(parsed?.metadata.recurrence, undefined);
});

test('MobileURIHandler: quick-capture with description appends it', async () => {
  const captured: string[] = [];
  const handler = new MobileURIHandler({} as any, async (task) => { captured.push(task); });
  await handler.handleCaptureURI('obsidian://quick-capture?title=Task&description=More+details');
  assert.deepEqual(captured, ['Task\nMore details']);
});

test('MobileURIHandler: schedule-task with relative date tomorrow', async () => {
  const captured: string[] = [];
  const handler = new MobileURIHandler({} as any, async (task) => { captured.push(task); });
  await handler.handleCaptureURI('obsidian://schedule-task?title=Meeting&due=tomorrow');
  assert.equal(captured.length, 1);
  assert.match(captured[0], /Meeting 📅 \d{4}-\d{2}-\d{2}/);
});

test('MobileURIHandler: schedule-task with relative date next-week', async () => {
  const captured: string[] = [];
  const handler = new MobileURIHandler({} as any, async (task) => { captured.push(task); });
  await handler.handleCaptureURI('obsidian://schedule-task?title=Review&due=next-week');
  assert.equal(captured.length, 1);
  assert.match(captured[0], /Review 📅 \d{4}-\d{2}-\d{2}/);
});

test('MobileURIHandler: blocks unsafe quick-capture callback URLs', async () => {
  const originalFetch = globalThis.fetch;
  const fetched: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    fetched.push(String(input));
    return { ok: true } as Response;
  }) as typeof fetch;
  try {
    const captured: string[] = [];
    const handler = new MobileURIHandler({} as any, async (task) => { captured.push(task); }, publicHostnameResolver);
    await handler.handleCaptureURI('obsidian://quick-capture?title=Ping&callback=http%3A%2F%2F127.0.0.1%3A11434%2Fapi');
    assert.deepEqual(captured, ['Ping']);
    assert.deepEqual(fetched, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('MobileURIHandler: blocks callbacks whose host resolves to a private address', async () => {
  const originalFetch = globalThis.fetch;
  const fetched: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    fetched.push(String(input));
    return { ok: true } as Response;
  }) as typeof fetch;
  try {
    const captured: string[] = [];
    const handler = new MobileURIHandler({} as any, async (task) => { captured.push(task); }, privateHostnameResolver);
    await handler.handleCaptureURI('obsidian://quick-capture?title=Ping&callback=https%3A%2F%2Fpublic.example%2Fdone');
    assert.deepEqual(captured, ['Ping']);
    assert.deepEqual(fetched, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('MobileURIHandler: public callback is blocked when no pinning and no-redirect transport exists', async () => {
  const captured: string[] = [];
  const handler = new MobileURIHandler(
    {} as never,
    async (task) => { captured.push(task); },
    publicHostnameResolver,
  );

  await handler.handleCaptureURI('obsidian://quick-capture?title=Ping&callback=https%3A%2F%2Fexample.com%2Fdone');

  assert.deepEqual(captured, ['Ping']);
});

test('MobileURIHandler: quick-capture callback uses the validated pinned address', async () => {
  const captured: string[] = [];
  const callbackCapture: { request?: SafeTaskCallbackRequest; called?: boolean } = {};
  const handler = new MobileURIHandler(
    {} as any,
    async (task) => { captured.push(task); },
    publicHostnameResolver,
    captureCallbackTransport(callbackCapture),
  );

  await handler.handleCaptureURI('obsidian://quick-capture?title=Ping&callback=https%3A%2F%2Fexample.com%2Fdone');

  assert.deepEqual(captured, ['Ping']);
  assert.equal(callbackCapture.called, true);
  assert.equal(callbackCapture.request?.url.hostname, 'example.com');
  assert.equal(callbackCapture.request?.address, '93.184.216.34');
  assert.equal(callbackCapture.request?.timeoutMs, 10_000);
});
