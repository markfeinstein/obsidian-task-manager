import { isLocalOrPrivateHost } from './url-safety';

export const LOCAL_AI_ENDPOINT_ERROR = 'Local AI endpoint must use HTTP(S) on localhost, a .local host, or a private network address.';

export function isSafeLocalAiEndpoint(endpoint: string): boolean {
  try {
    const parsed = new URL(endpoint.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    if (parsed.username || parsed.password) return false;

    const hostname = parsed.hostname.toLowerCase().replace(/^\[(.*)\]$/u, '$1').replace(/\.$/u, '');
    return hostname.endsWith('.local') || isLocalOrPrivateHost(parsed.hostname);
  } catch {
    return false;
  }
}
