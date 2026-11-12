import type { TestContext } from 'node:test';
import type { AdapterCapability, FieldConflict, SyncAdapter } from '../src/sync-contract';
import type { MarkdownTask } from '../src/task-model';

export interface MockFetchCall {
  url: string;
  method: string;
  init?: RequestInit;
  body?: unknown;
  headers: Record<string, string>;
}

type MockRouteHandler = (call: MockFetchCall) => MockFetchResponse | Promise<MockFetchResponse>;

interface MockRoute {
  method?: string;
  matcher: RegExp | string | ((call: MockFetchCall) => boolean);
  handler: MockRouteHandler;
}

export interface MockFetchResponse {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

function normalizeHeaders(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) {
    const result: Record<string, string> = {};
    headers.forEach((value, key) => { result[key] = value; });
    return result;
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers.map(([key, value]) => [key, value]));
  }
  return { ...headers };
}

function parseBody(body: BodyInit | null | undefined): unknown {
  if (typeof body !== 'string') return body;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return body;
  }
}

function toResponse(response: MockFetchResponse): Response {
  const status = response.status ?? 200;
  const body = response.body ?? {};
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(response.headers ?? {}),
    json: async () => body,
    text: async () => typeof body === 'string' ? body : JSON.stringify(body),
  } as Response;
}

export class MockFetchRouter {
  readonly calls: MockFetchCall[] = [];
  private routes: MockRoute[] = [];
  private originalFetch?: typeof fetch;

  route(method: string | undefined, matcher: MockRoute['matcher'], handler: MockRouteHandler): this {
    this.routes.push({ method: method?.toUpperCase(), matcher, handler });
    return this;
  }

  install(): () => void {
    this.originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      const method = (init?.method ?? (input instanceof Request ? input.method : 'GET') ?? 'GET').toUpperCase();
      const headers = normalizeHeaders(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      const call: MockFetchCall = { url, method, init, headers, body: parseBody(init?.body) };
      this.calls.push(call);
      const route = this.routes.find((candidate) => this.matches(candidate, call));
      if (!route) {
        return toResponse({ status: 404, body: { error: `No mock route for ${method} ${url}` } });
      }
      return toResponse(await route.handler(call));
    }) as typeof fetch;
    return () => this.restore();
  }

  installForTest(context: TestContext): this {
    const restore = this.install();
    context.after(restore);
    return this;
  }

  restore(): void {
    if (this.originalFetch) {
      globalThis.fetch = this.originalFetch;
      this.originalFetch = undefined;
    }
  }

  count(predicate?: (call: MockFetchCall) => boolean): number {
    return predicate ? this.calls.filter(predicate).length : this.calls.length;
  }

  private matches(route: MockRoute, call: MockFetchCall): boolean {
    if (route.method && route.method !== call.method) return false;
    if (typeof route.matcher === 'string') return call.url === route.matcher;
    if (route.matcher instanceof RegExp) return route.matcher.test(call.url);
    return route.matcher(call);
  }
}

export interface ExternalEndpointOptions {
  googleTasks?: Array<Record<string, unknown>>;
  microsoftLists?: Array<Record<string, unknown>>;
  microsoftTasks?: Array<Record<string, unknown>>;
  googleStatus?: number;
  microsoftStatus?: number;
  googleTokenRefreshStatus?: number;
  microsoftTokenRefreshStatus?: number;
}

export function createExternalSyncEndpointMock(options: ExternalEndpointOptions = {}): MockFetchRouter {
  const router = new MockFetchRouter();
  const googleTasks = options.googleTasks ?? [{ id: 'g1', title: 'Google task', status: 'needsAction' }];
  const microsoftLists = options.microsoftLists ?? [{ id: 'default-list', wellknownListName: 'defaultList' }];
  const microsoftTasks = options.microsoftTasks ?? [{ id: 'm1', title: 'Microsoft task', status: 'notStarted', isReminderOn: false }];

  router.route('GET', /https:\/\/tasks\.googleapis\.com\/tasks\/v1\/lists\/[^/]+\/tasks/u, (call) => {
    const hasBearer = call.headers.Authorization?.startsWith('Bearer ') || call.headers.authorization?.startsWith('Bearer ');
    const hasApiKey = new URL(call.url).searchParams.has('key');
    if (!hasBearer && !hasApiKey) return { status: 401, body: { error: 'missing Google credentials' } };
    return { status: options.googleStatus ?? 200, body: { items: googleTasks } };
  });

  router.route(undefined, /https:\/\/oauth2\.googleapis\.com\/token/u, () => ({
    status: options.googleTokenRefreshStatus ?? 400,
    body: { error: 'invalid_grant', error_description: 'mock refresh failure' },
  }));

  router.route('GET', 'https://graph.microsoft.com/v1.0/me/todo/lists', (call) => {
    const hasBearer = call.headers.Authorization?.startsWith('Bearer ') || call.headers.authorization?.startsWith('Bearer ');
    if (!hasBearer) return { status: 401, body: { error: { code: 'InvalidAuthenticationToken' } } };
    return { status: 200, body: { value: microsoftLists } };
  });

  router.route('GET', /https:\/\/graph\.microsoft\.com\/v1\.0\/me\/todo\/lists\/[^/]+\/tasks/u, (call) => {
    const hasBearer = call.headers.Authorization?.startsWith('Bearer ') || call.headers.authorization?.startsWith('Bearer ');
    if (!hasBearer) return { status: 401, body: { error: { code: 'InvalidAuthenticationToken' } } };
    return { status: options.microsoftStatus ?? 200, body: { value: microsoftTasks } };
  });

  router.route(undefined, /https:\/\/login\.microsoftonline\.com\/common\/oauth2\/v2\.0\/token/u, () => ({
    status: options.microsoftTokenRefreshStatus ?? 400,
    body: { error: 'invalid_grant', error_description: 'mock refresh failure' },
  }));

  return router;
}

export function makeHarnessTask(overrides: Partial<MarkdownTask> = {}): MarkdownTask {
  return {
    key: 'Harness.md:External task',
    filePath: 'Harness.md',
    lineNumber: 1,
    rawLine: '- [ ] External task',
    linePrefix: '',
    indentation: '',
    listMarker: '-',
    checkbox: ' ',
    body: 'External task',
    normalizedText: 'External task',
    status: 'todo',
    tags: [],
    contexts: [],
    metadata: { dates: {}, invalidDates: {}, priority: 'normal', dependsOn: [] },
    ...overrides,
  } as MarkdownTask;
}

export interface MockAdapterOptions {
  service?: string;
  failCreates?: number;
  failUpdates?: number;
  conflicts?: FieldConflict[];
}

export function createFlakySyncAdapter(options: MockAdapterOptions = {}): SyncAdapter & { attempts: Record<string, number> } {
  const service = options.service ?? 'external-test';
  const attempts = { create: 0, update: 0, delete: 0, reopen: 0 };
  const caps: AdapterCapability = {
    service,
    status: 'experimental',
    supports: { create: true, update: true, delete: true, reopen: true },
    fields: { title: 'native', status: 'native' },
  };
  return {
    attempts,
    getCapabilities: () => caps,
    isConfigured: async () => true,
    toServicePayload: (task) => ({ title: task.body }),
    fromServicePayload: (payload, vaultPath) => makeHarnessTask({ filePath: vaultPath, body: String(payload.title ?? 'External task') }),
    create: async (payload) => {
      attempts.create++;
      if (attempts.create <= (options.failCreates ?? 0)) {
        const error = new Error(`mock create failure ${attempts.create}`) as Error & { statusCode?: number };
        error.statusCode = 503;
        throw error;
      }
      return { externalId: 'external-created', hash: JSON.stringify(payload) };
    },
    update: async (_externalId, payload) => {
      attempts.update++;
      if (attempts.update <= (options.failUpdates ?? 0)) {
        const error = new Error(`mock update failure ${attempts.update}`) as Error & { statusCode?: number };
        error.statusCode = 503;
        throw error;
      }
      return { hash: JSON.stringify(payload), conflicts: options.conflicts };
    },
    delete: async () => { attempts.delete++; },
    reopen: async () => { attempts.reopen++; },
    fetchAll: async () => [],
    testConnection: async () => ({ ok: true }),
  };
}
