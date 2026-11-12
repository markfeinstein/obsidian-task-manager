import test from 'node:test';
import assert from 'node:assert/strict';
import TaskManagerPlugin from '../src/main';
import {
  buildPkceAuthorizationUrl,
  exchangeAuthorizationCodeForToken,
  parseOAuthCode,
  pkceChallengeForVerifier,
  refreshOAuthAccessToken,
  tokenExpiresSoon,
} from '../src/oauth-pkce';
import {
  exchangeGoogleTasksAuthorizationCode,
  googleTasksPkceOAuthStart,
  refreshGoogleTasksAccessToken,
} from '../src/google-tasks-sync';
import { exchangeGoogleCalendarAuthorizationCode } from '../src/google-calendar-sync';
import {
  exchangeMicrosoftTodoAuthorizationCode,
  microsoftTodoPkceOAuthStart,
  refreshMicrosoftTodoAccessToken,
} from '../src/microsoft-todo-sync';
import { normalizeTaskManagerSettings } from '../src/types';

test('wave D1: PKCE challenge and authorization URL are deterministic with a supplied verifier', async () => {
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  assert.equal(await pkceChallengeForVerifier(verifier), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');

  const start = await buildPkceAuthorizationUrl({
    authorizationEndpoint: 'https://example.test/oauth/authorize',
    clientId: 'client-123',
    redirectUri: 'http://localhost/callback',
    scope: 'tasks.read tasks.write',
    state: 'state-1',
    codeVerifier: verifier,
  });

  assert.equal(start.codeVerifier, verifier);
  assert.equal(start.codeChallenge, 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  const url = new URL(start.authorizationUrl);
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('code_challenge'), start.codeChallenge);
  assert.equal(url.searchParams.get('state'), 'state-1');
});

test('wave D1: authorization URL preserves existing endpoint query params', async () => {
  const start = await buildPkceAuthorizationUrl({
    authorizationEndpoint: 'https://example.test/oauth/authorize?tenant=team-a',
    clientId: 'client-123',
    redirectUri: 'http://localhost/callback',
    scope: 'tasks.read',
    codeVerifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
  });

  const url = new URL(start.authorizationUrl);
  assert.equal(url.searchParams.get('tenant'), 'team-a');
  assert.equal(url.searchParams.get('client_id'), 'client-123');
  assert.equal(url.searchParams.get('response_type'), 'code');
});

test('wave D1: OAuth code parser accepts raw codes and callback URLs', () => {
  assert.deepEqual(parseOAuthCode('abc123'), { code: 'abc123' });
  assert.deepEqual(parseOAuthCode('http-code-from-provider'), { code: 'http-code-from-provider' });
  assert.deepEqual(parseOAuthCode('http://localhost/callback?code=code-1&state=state-1'), { code: 'code-1', state: 'state-1' });
  assert.throws(() => parseOAuthCode('http://localhost/callback?error=denied'), /does not contain a code/u);
});

test('wave D1: token exchange and refresh helpers post fetch-mockable form requests', async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; body: string }> = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), body: String(init?.body ?? '') });
    return {
      ok: true,
      status: 200,
      json: async () => ({ access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600, token_type: 'Bearer', scope: 'scope-a' }),
    } as Response;
  }) as typeof fetch;
  try {
    const exchanged = await exchangeAuthorizationCodeForToken({
      tokenEndpoint: 'https://example.test/token',
      clientId: 'client-123',
      code: 'code-1',
      codeVerifier: 'verifier-1',
      redirectUri: 'http://localhost/callback',
    });
    const refreshed = await refreshOAuthAccessToken({
      tokenEndpoint: 'https://example.test/token',
      clientId: 'client-123',
      refreshToken: 'refresh-existing',
      scope: 'scope-a',
    });

    assert.equal(exchanged.accessToken, 'access-1');
    assert.equal(exchanged.refreshToken, 'refresh-1');
    assert.ok(exchanged.expiresAt);
    assert.equal(refreshed.accessToken, 'access-1');
    assert.equal(requests.length, 2);
    assert.match(requests[0].body, /grant_type=authorization_code/u);
    assert.match(requests[0].body, /code_verifier=verifier-1/u);
    assert.match(requests[1].body, /grant_type=refresh_token/u);
    assert.match(requests[1].body, /refresh_token=refresh-existing/u);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('wave D1: Google and Microsoft service PKCE helpers use provider endpoints and parse callback URLs', async () => {
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  const google = await googleTasksPkceOAuthStart('google-client', { codeVerifier: verifier, state: 'g-state' });
  assert.match(google.authorizationUrl, /^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/u);
  assert.match(google.authorizationUrl, /access_type=offline/u);
  assert.match(google.authorizationUrl, /prompt=consent/u);

  const microsoft = await microsoftTodoPkceOAuthStart('ms-client', { codeVerifier: verifier, state: 'm-state' });
  assert.match(microsoft.authorizationUrl, /^https:\/\/login\.microsoftonline\.com\/common\/oauth2\/v2\.0\/authorize\?/u);
  assert.match(microsoft.authorizationUrl, /offline_access/u);

  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request) => {
    urls.push(String(url));
    return { ok: true, status: 200, json: async () => ({ access_token: 'access', expires_in: 1200 }) } as Response;
  }) as typeof fetch;
  try {
    await exchangeGoogleTasksAuthorizationCode({ clientId: 'google-client', codeOrCallbackUrl: `${google.redirectUri}?code=g-code`, codeVerifier: verifier, redirectUri: google.redirectUri });
    await exchangeMicrosoftTodoAuthorizationCode({ clientId: 'ms-client', codeOrCallbackUrl: `${microsoft.redirectUri}?code=m-code`, codeVerifier: verifier, redirectUri: microsoft.redirectUri });
    await refreshGoogleTasksAccessToken({ clientId: 'google-client', refreshToken: 'g-refresh' });
    await refreshMicrosoftTodoAccessToken({ clientId: 'ms-client', refreshToken: 'm-refresh' });
    assert.deepEqual(urls, [
      'https://oauth2.googleapis.com/token',
      'https://login.microsoftonline.com/common/oauth2/v2.0/token',
      'https://oauth2.googleapis.com/token',
      'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('wave D1: Google Tasks and Microsoft OAuth exchanges validate callback state when provided', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  globalThis.fetch = (async () => {
    fetchCount += 1;
    return { ok: true, status: 200, json: async () => ({ access_token: 'access', expires_in: 1200 }) } as Response;
  }) as typeof fetch;
  try {
    await assert.rejects(
      exchangeGoogleTasksAuthorizationCode({
        clientId: 'google-client',
        codeOrCallbackUrl: 'http://localhost:42813/oauth/google-tasks/callback?code=g-code&state=wrong',
        codeVerifier: 'verifier-1',
        expectedState: 'expected',
      }),
      /callback state did not match/u,
    );
    await assert.rejects(
      exchangeMicrosoftTodoAuthorizationCode({
        clientId: 'ms-client',
        codeOrCallbackUrl: 'http://localhost:42813/oauth/microsoft-todo/callback?code=m-code&state=wrong',
        codeVerifier: 'verifier-1',
        expectedState: 'expected',
      }),
      /callback state did not match/u,
    );
    assert.equal(fetchCount, 0);

    const google = await exchangeGoogleTasksAuthorizationCode({
      clientId: 'google-client',
      codeOrCallbackUrl: 'http://localhost:42813/oauth/google-tasks/callback?code=g-code&state=expected',
      codeVerifier: 'verifier-1',
      expectedState: 'expected',
    });
    const microsoft = await exchangeMicrosoftTodoAuthorizationCode({
      clientId: 'ms-client',
      codeOrCallbackUrl: 'http://localhost:42813/oauth/microsoft-todo/callback?code=m-code&state=expected',
      codeVerifier: 'verifier-1',
      expectedState: 'expected',
    });
    assert.equal(google.accessToken, 'access');
    assert.equal(microsoft.accessToken, 'access');
    assert.equal(fetchCount, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('wave D1: Google Calendar OAuth exchange validates callback state when provided', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  globalThis.fetch = (async () => {
    fetchCount += 1;
    return { ok: true, status: 200, json: async () => ({ access_token: 'access', expires_in: 1200 }) } as Response;
  }) as typeof fetch;
  try {
    await assert.rejects(
      exchangeGoogleCalendarAuthorizationCode({
        clientId: 'google-client',
        codeOrCallbackUrl: 'http://localhost:42813/oauth/google-calendar/callback?code=g-code&state=wrong',
        codeVerifier: 'verifier-1',
        expectedState: 'expected',
      }),
      /callback state did not match/u,
    );
    assert.equal(fetchCount, 0);

    const token = await exchangeGoogleCalendarAuthorizationCode({
      clientId: 'google-client',
      codeOrCallbackUrl: 'http://localhost:42813/oauth/google-calendar/callback?code=g-code&state=expected',
      codeVerifier: 'verifier-1',
      expectedState: 'expected',
    });
    assert.equal(token.accessToken, 'access');
    assert.equal(fetchCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('wave D1: settings normalize refresh tokens and expiry tracking fields', () => {
  const settings = normalizeTaskManagerSettings({
    googleTasksRefreshToken: ' g-refresh ',
    googleTasksTokenExpiresAt: ' 2026-05-28T20:00:00.000Z ',
    msToDoRefreshToken: ' m-refresh ',
    msToDoTokenExpiresAt: ' 2026-05-28T21:00:00.000Z ',
  });
  assert.equal(settings.googleTasksRefreshToken, 'g-refresh');
  assert.equal(settings.googleTasksTokenExpiresAt, '2026-05-28T20:00:00.000Z');
  assert.equal(settings.msToDoRefreshToken, 'm-refresh');
  assert.equal(settings.msToDoTokenExpiresAt, '2026-05-28T21:00:00.000Z');
});

test('wave D1: plugin refresh helpers update stored access tokens before sync', async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request) => {
    calls.push(String(url));
    return {
      ok: true,
      status: 200,
      json: async () => ({ access_token: calls.length === 1 ? 'google-access-new' : 'ms-access-new', refresh_token: calls.length === 1 ? 'google-refresh-new' : 'ms-refresh-new', expires_in: 3600 }),
    } as Response;
  }) as typeof fetch;
  const plugin = Object.create(TaskManagerPlugin.prototype) as any;
  let saveCount = 0;
  plugin.settings = normalizeTaskManagerSettings({
    googleTasksOAuthClientId: 'google-client',
    googleTasksAccessToken: 'old-google',
    googleTasksRefreshToken: 'old-google-refresh',
    googleTasksTokenExpiresAt: new Date(Date.now() - 1000).toISOString(),
    msToDoClientId: 'ms-client',
    msToDoToken: 'old-ms',
    msToDoRefreshToken: 'old-ms-refresh',
    msToDoTokenExpiresAt: new Date(Date.now() - 1000).toISOString(),
  });
  plugin.saveSettings = async () => { saveCount += 1; };
  try {
    await plugin.refreshGoogleTasksTokenIfNeeded();
    await plugin.refreshMicrosoftTodoTokenIfNeeded();
    assert.equal(plugin.settings.googleTasksAccessToken, 'google-access-new');
    assert.equal(plugin.settings.googleTasksRefreshToken, 'google-refresh-new');
    assert.equal(plugin.settings.msToDoToken, 'ms-access-new');
    assert.equal(plugin.settings.msToDoRefreshToken, 'ms-refresh-new');
    assert.equal(saveCount, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('wave D1: OAuth token responses with zero lifetime are marked expired', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    json: async () => ({ access_token: 'access-immediate-expiry', expires_in: 0 }),
  } as Response)) as typeof fetch;
  try {
    const token = await exchangeAuthorizationCodeForToken({
      tokenEndpoint: 'https://example.test/token',
      clientId: 'client-123',
      code: 'code-1',
      codeVerifier: 'verifier-1',
      redirectUri: 'http://localhost/callback',
    });

    assert.ok(token.expiresAt);
    assert.equal(tokenExpiresSoon(token.expiresAt), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('wave D1: OAuth token failures include provider error details', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: false,
    status: 400,
    statusText: 'Bad Request',
    text: async () => JSON.stringify({ error: 'invalid_grant', error_description: 'Refresh token revoked' }),
  } as Response)) as typeof fetch;
  try {
    await assert.rejects(
      () => refreshOAuthAccessToken({
        tokenEndpoint: 'https://example.test/token',
        clientId: 'client-123',
        refreshToken: 'refresh-existing',
      }),
      /OAuth token endpoint error: 400 - invalid_grant: Refresh token revoked/u,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('wave D1: token expiry helper is conservative', () => {
  assert.equal(tokenExpiresSoon(undefined), false);
  assert.equal(tokenExpiresSoon('not-a-date'), true);
  assert.equal(tokenExpiresSoon(new Date(Date.now() - 1).toISOString()), true);
  assert.equal(tokenExpiresSoon(new Date(Date.now() + 3_600_000).toISOString()), false);
});

test('wave D1: OAuth error details redact a reflected refresh token value', async () => {
  const originalFetch = globalThis.fetch;
  const leaked = 'refresh-secret-value-1234';
  globalThis.fetch = (async () => ({
    ok: false,
    status: 400,
    statusText: 'Bad Request',
    text: async () => JSON.stringify({ error: 'invalid_grant', error_description: `token ${leaked} rejected` }),
  } as Response)) as typeof fetch;
  try {
    await assert.rejects(
      () => refreshOAuthAccessToken({
        tokenEndpoint: 'https://example.test/token',
        clientId: 'client-123',
        refreshToken: leaked,
      }),
      (error: unknown) => {
        const message = (error as Error).message;
        assert.ok(!message.includes(leaked), 'reflected refresh token must be redacted');
        assert.match(message, /\[redacted\]/u);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('wave D1: short OAuth secrets suppress all endpoint-controlled error detail', async () => {
  const originalFetch = globalThis.fetch;
  for (let length = 1; length <= 7; length += 1) {
    const leaked = 's'.repeat(length);
    globalThis.fetch = (async () => ({
      ok: false,
      status: 400,
      statusText: `status reflected ${leaked}`,
      text: async () => JSON.stringify({ error: 'invalid_grant', error_description: `body reflected ${leaked}` }),
    } as Response)) as typeof fetch;
    await assert.rejects(
      () => refreshOAuthAccessToken({ tokenEndpoint: 'https://example.test/token', clientId: 'client-123', refreshToken: leaked }),
      (error: unknown) => {
        assert.equal((error as Error).message, 'OAuth token endpoint error: 400');
        return true;
      },
    );
  }
  globalThis.fetch = originalFetch;
});
