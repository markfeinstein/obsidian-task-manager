import { OAUTH_NETWORK_MAX_BYTES, requestResponse } from './network-request';
/**
 * OAuth 2.0 PKCE helpers for external task integrations.
 *
 * The helpers are UI/runtime agnostic and fetch-mockable in tests. They do not
 * start a localhost server; callers can paste either an authorization code or a
 * full redirected callback URL into a manual completion flow.
 */

export interface OAuthPkceStart {
  authorizationUrl: string;
  codeVerifier: string;
  codeChallenge: string;
  state?: string;
  redirectUri: string;
}

export interface OAuthTokenResponse {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  scope?: string;
  tokenType?: string;
  raw: Record<string, unknown>;
}

export interface OAuthTokenRequest {
  tokenEndpoint: string;
  clientId: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
  signal?: AbortSignal;
}

export interface OAuthRefreshRequest {
  tokenEndpoint: string;
  clientId: string;
  refreshToken: string;
  scope?: string;
  signal?: AbortSignal;
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

export function generatePkceVerifier(byteLength = 64): string {
  const length = Math.max(32, Math.min(96, Math.floor(byteLength)));
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

export async function pkceChallengeForVerifier(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
  return base64UrlEncode(new Uint8Array(digest));
}

export async function buildPkceAuthorizationUrl(options: {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  scope: string;
  state?: string;
  codeVerifier?: string;
  extraParams?: Record<string, string | undefined>;
}): Promise<OAuthPkceStart> {
  const clientId = options.clientId.trim();
  if (!clientId) throw new Error('OAuth client ID is required');
  const codeVerifier = options.codeVerifier ?? generatePkceVerifier();
  const codeChallenge = await pkceChallengeForVerifier(codeVerifier);
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: options.redirectUri,
    scope: options.scope,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });
  if (options.state) params.set('state', options.state);
  for (const [key, value] of Object.entries(options.extraParams ?? {})) {
    if (value !== undefined && value !== '') params.set(key, value);
  }
  const separator = options.authorizationEndpoint.includes('?') ? '&' : '?';
  return {
    authorizationUrl: `${options.authorizationEndpoint}${separator}${params.toString()}`,
    codeVerifier,
    codeChallenge,
    state: options.state,
    redirectUri: options.redirectUri,
  };
}

export function parseOAuthCode(input: string): { code: string; state?: string } {
  const value = input.trim();
  if (!value) throw new Error('OAuth authorization code is required');
  try {
    const url = new URL(value);
    const code = url.searchParams.get('code') ?? (url.hash ? new URLSearchParams(url.hash.replace(/^#/u, '')).get('code') : null);
    const state = url.searchParams.get('state') ?? (url.hash ? new URLSearchParams(url.hash.replace(/^#/u, '')).get('state') ?? undefined : undefined);
    if (!code) throw new Error('OAuth callback URL does not contain a code parameter');
    return { code, state: state ?? undefined };
  } catch (error) {
    if (value.includes('://') || /^https?:\/\//iu.test(value)) throw error;
    return { code: value };
  }
}

function parseTokenPayload(raw: Record<string, unknown>, fallbackRefreshToken?: string): OAuthTokenResponse {
  const accessToken = typeof raw.access_token === 'string' ? raw.access_token : '';
  if (!accessToken) throw new Error('OAuth token response did not include an access token');
  const expiresIn = typeof raw.expires_in === 'number' && Number.isFinite(raw.expires_in) ? raw.expires_in : undefined;
  return {
    accessToken,
    refreshToken: typeof raw.refresh_token === 'string' && raw.refresh_token ? raw.refresh_token : fallbackRefreshToken,
    expiresAt: expiresIn !== undefined ? new Date(Date.now() + Math.max(0, expiresIn - 60) * 1000).toISOString() : undefined,
    scope: typeof raw.scope === 'string' ? raw.scope : undefined,
    tokenType: typeof raw.token_type === 'string' ? raw.token_type : undefined,
    raw,
  };
}

function oauthErrorDetailFromPayload(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const record = payload as {
    error?: unknown;
    error_description?: unknown;
    message?: unknown;
  };

  if (record.error && typeof record.error === 'object') {
    const nested = record.error as { message?: unknown; status?: unknown; code?: unknown };
    if (typeof nested.message === 'string' && nested.message.trim()) return nested.message.trim();
    if (typeof nested.status === 'string' && nested.status.trim()) return nested.status.trim();
    if (typeof nested.code === 'string' && nested.code.trim()) return nested.code.trim();
  }

  if (typeof record.error === 'string' && typeof record.error_description === 'string') {
    return `${record.error}: ${record.error_description}`;
  }
  if (typeof record.error_description === 'string' && record.error_description.trim()) return record.error_description.trim();
  if (typeof record.error === 'string' && record.error.trim()) return record.error.trim();
  if (typeof record.message === 'string' && record.message.trim()) return record.message.trim();
  return undefined;
}

async function postOAuthTokenForm(endpoint: string, form: URLSearchParams, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const response = await requestResponse(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
    signal,
  }, { signal, maxBytes: OAUTH_NETWORK_MAX_BYTES, redirect: 'error' });
  if (!response.ok) {
    let detail = '';
    try {
      const text = (await response.text()).trim();
      if (text) {
        try {
          detail = oauthErrorDetailFromPayload(JSON.parse(text)) ?? text;
        } catch {
          detail = text;
        }
      }
    } catch {
      detail = '';
    }
    const statusText = response.statusText?.trim() ?? '';
    const redacted = redactOAuthErrorDetail(detail || statusText, form);
    const suffix = redacted ?? '';
    throw new Error(`OAuth token endpoint error: ${response.status}${suffix ? ` - ${suffix}` : ''}`);
  }
  return await response.json() as Record<string, unknown>;
}

// A misbehaving or hostile token endpoint could reflect submitted secrets
// (authorization code, PKCE verifier, refresh token) back in its error body.
// Strip those exact values and bound the length before the detail enters a
// thrown Error message that callers may log.
function redactOAuthErrorDetail(detail: string, form: URLSearchParams): string | null {
  if (!detail) return '';
  const values = ['code', 'code_verifier', 'refresh_token', 'client_secret']
    .map((key) => form.get(key))
    .filter((value): value is string => Boolean(value));
  // Replacing a one-character secret globally destroys diagnostic meaning and is
  // easy to get wrong. Suppress all endpoint-controlled detail instead.
  if (values.some((value) => value.length < 8)) return null;
  let out = detail;
  for (const value of [...values].sort((left, right) => right.length - left.length)) {
    out = out.split(value).join('[redacted]');
  }
  return out.length > 500 ? `${out.slice(0, 500)}\u2026` : out;
}

export async function exchangeAuthorizationCodeForToken(request: OAuthTokenRequest): Promise<OAuthTokenResponse> {
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: request.clientId.trim(),
    code: request.code.trim(),
    code_verifier: request.codeVerifier.trim(),
    redirect_uri: request.redirectUri,
  });
  const raw = await postOAuthTokenForm(request.tokenEndpoint, form, request.signal);
  return parseTokenPayload(raw);
}

export async function refreshOAuthAccessToken(request: OAuthRefreshRequest): Promise<OAuthTokenResponse> {
  const refreshToken = request.refreshToken.trim();
  if (!refreshToken) throw new Error('OAuth refresh token is required');
  const form = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: request.clientId.trim(),
    refresh_token: refreshToken,
  });
  if (request.scope) form.set('scope', request.scope);
  const raw = await postOAuthTokenForm(request.tokenEndpoint, form, request.signal);
  return parseTokenPayload(raw, refreshToken);
}

export function tokenExpiresSoon(expiresAt: string | undefined, skewMs = 60_000): boolean {
  if (!expiresAt?.trim()) return false;
  const expiryMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiryMs)) return true;
  return expiryMs - Date.now() <= skewMs;
}
