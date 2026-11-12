export type HostnameResolver = (hostname: string) => Promise<readonly string[] | null>;

export interface SafeHttpsRequestTarget {
  url: URL;
  address: string;
}

export function isLocalOrPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[(.*)\]$/u, '$1').replace(/\.$/u, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (host.includes(':')) {
    if (host === '::' || host === '0:0:0:0:0:0:0:0') return true;
    if (host === '::1' || host === '0:0:0:0:0:0:0:1') return true;
    if (/^64:ff9b:/iu.test(host) || /^100:/iu.test(host)) return true;
    const hextets = host.split(':');
    const firstHextet = Number.parseInt(hextets[0] ?? '', 16);
    const secondHextet = hextets[1] === '' ? 0 : Number.parseInt(hextets[1] ?? '', 16);
    if (firstHextet === 0x2001 && (
      secondHextet === 0
      || secondHextet === 2
      || secondHextet === 3
      || secondHextet === 4
      || (secondHextet >= 0x10 && secondHextet <= 0x2f)
      || secondHextet === 0x0db8
    )) return true;
    if (firstHextet === 0x2002) return true;
    if (/^fe[89a-f][0-9a-f]/iu.test(host) || /^f[cd]/iu.test(host) || /^ff/iu.test(host)) return true;
    const dottedIpv4MappedMatch = host.match(/^::ffff:((\d+\.){3}\d+)$/iu);
    if (dottedIpv4MappedMatch) return isLocalOrPrivateHost(dottedIpv4MappedMatch[1]);
    const hexIpv4MappedMatch = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/iu);
    if (hexIpv4MappedMatch) {
      const high = Number.parseInt(hexIpv4MappedMatch[1], 16);
      const low = Number.parseInt(hexIpv4MappedMatch[2], 16);
      return isLocalOrPrivateHost(`${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`);
    }
  }

  const parts = host.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [a, b, c] = parts;
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0 && (c === 0 || c === 2))
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
    || (a === 203 && b === 0 && c === 113)
    || a >= 224;
}

export function isHttpsPublicUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && !isLocalOrPrivateHost(parsed.hostname);
  } catch {
    return false;
  }
}

export function resolveHostnameWithNodeDns(_hostname: string): Promise<readonly string[] | null> {
  // Compatibility export only. The mobile-safe plugin has no transport that can
  // bind a validated DNS answer to the subsequent TLS request and reject every
  // redirect hop, so production resolution fails closed. A trusted companion or
  // test may inject a resolver together with a transport that actually pins it.
  return Promise.resolve(null);
}

export async function resolveSafeHttpsUrlForRequest(value: string, resolver?: HostnameResolver): Promise<SafeHttpsRequestTarget | null> {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'https:' || isLocalOrPrivateHost(parsed.hostname)) {
    return null;
  }

  const addresses = await (resolver ?? resolveHostnameWithNodeDns)(parsed.hostname);
  // Outbound requests must fail closed when DNS validation is unavailable. A
  // public-looking hostname can still resolve to a private/internal address at
  // request time, so only allow hosts whose resolved addresses are known public IPs.
  if (addresses === null || addresses.length === 0 || addresses.some((address) => isLocalOrPrivateHost(address))) {
    return null;
  }
  return { url: parsed, address: addresses[0] };
}

export async function isSafeHttpsUrlForRequest(value: string, resolver?: HostnameResolver): Promise<boolean> {
  return (await resolveSafeHttpsUrlForRequest(value, resolver)) !== null;
}
