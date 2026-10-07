import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * SSRF protection for server-side outbound requests to user-supplied URLs
 * (webhook delivery, etc.). Rejects non-http(s) schemes and any host that
 * resolves to a private / loopback / link-local / metadata address.
 */

export class UnsafeUrlError extends Error {}

function ipv4ToParts(ip: string): number[] | null {
  const parts = ip.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return parts;
}

/** True for loopback / private / link-local / CGNAT / metadata / unspecified ranges. */
export function isPrivateIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const p = ipv4ToParts(ip);
    if (!p) return true; // unparseable → treat as unsafe
    const [a, b] = p as [number, number, number, number];
    if (a === 0 || a === 10 || a === 127) return true; // this-host, private, loopback
    if (a === 169 && b === 254) return true; // link-local + 169.254.169.254 metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true; // private
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a === 192 && b === 0) return true; // 192.0.0.0/24 IETF protocol
    if (a >= 224) return true; // multicast / reserved
    return false;
  }
  if (v === 6) {
    // URL canonicalisation changes dotted mapped addresses into hexadecimal.
    const canonical = new URL(`http://[${ip}]/`).hostname.slice(1, -1);
    const [left = '', right = ''] = canonical.split('::');
    const head = left ? left.split(':') : [];
    const tail = right ? right.split(':') : [];
    const parts = canonical.includes('::')
      ? [...head, ...Array<string>(8 - head.length - tail.length).fill('0'), ...tail]
      : head;
    const words = parts.map((word) => Number.parseInt(word, 16));
    if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff) {
      const high = words[6]!;
      const low = words[7]!;
      return isPrivateIp(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
    }
    // Accept global unicast only. This also excludes compatible/translated
    // literals, multicast, link-local, ULA, unspecified and loopback addresses.
    return (words[0]! & 0xe000) !== 0x2000;
  }
  return true; // not an IP literal handled here
}

function isBlockedHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal') || h.endsWith('.local')) {
    return true;
  }
  if (isIP(h) && isPrivateIp(h)) return true;
  return false;
}

/**
 * Validate a URL is a safe public http(s) target. Resolves DNS and re-checks the
 * resolved addresses. The caller must bind its connection to these addresses
 * to prevent DNS-rebinding. Throws UnsafeUrlError otherwise.
 */
export async function resolveSafeOutboundUrl(
  raw: string,
  opts: { requireHttps?: boolean } = {},
): Promise<{ url: URL; addresses: { address: string; family: number }[] }> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeUrlError('Invalid URL');
  }
  const scheme = url.protocol.replace(/:$/, '');
  if (opts.requireHttps ? scheme !== 'https' : scheme !== 'http' && scheme !== 'https') {
    throw new UnsafeUrlError(`Disallowed URL scheme: ${scheme}`);
  }
  if (url.username || url.password || url.hash) throw new UnsafeUrlError('URL credentials and fragments are not allowed');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (isBlockedHostname(hostname)) {
    throw new UnsafeUrlError('URL host is not allowed (private/loopback)');
  }
  // If the host is a DNS name, resolve and re-check every address.
  if (isIP(hostname) === 0) {
    let addrs: { address: string; family: number }[];
    try {
      addrs = await lookup(hostname, { all: true });
    } catch {
      throw new UnsafeUrlError('URL host could not be resolved');
    }
    if (addrs.length === 0 || addrs.some((a) => isPrivateIp(a.address))) {
      throw new UnsafeUrlError('URL host resolves to a private address');
    }
    return { url, addresses: addrs };
  }
  return { url, addresses: [{ address: hostname, family: isIP(hostname) }] };
}

/** Validation alone does not pin a later fetch's DNS. Use returned addresses when connecting. */
export async function assertSafeOutboundUrl(raw: string, opts: { requireHttps?: boolean } = {}): Promise<void> {
  await resolveSafeOutboundUrl(raw, opts);
}

/**
 * SSRF guard for outbound OTA channel-adapter requests. The endpoint base URL
 * comes from tenant-supplied channel-connection config, so a property admin could
 * point it at an internal/metadata host and trigger a server-side fetch. Block
 * private targets in production. Local/dev (docker mock OTA servers on private
 * hosts) is allowed unless explicitly locked down, mirroring the project's
 * NODE_ENV / opt-in posture (cf. HAIP_ALLOW_INSECURE).
 */
export async function assertSafeChannelEndpoint(raw: string): Promise<void> {
  // Enforce for any production-like environment (production OR staging), matching
  // assertSecureConfig — staging is internet-adjacent and must not allow SSRF either.
  const nodeEnv = process.env['NODE_ENV'];
  const productionLike = nodeEnv === 'production' || nodeEnv === 'staging';
  const enforce = productionLike && process.env['CHANNEL_ALLOW_PRIVATE_ENDPOINTS'] !== 'true';
  if (!enforce) return;
  await assertSafeOutboundUrl(raw);
}

/** Sync, literal-only check for DTO validation (no DNS). */
export function isLiterallySafeHttpUrl(raw: string, opts: { requireHttps?: boolean } = {}): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  const scheme = url.protocol.replace(/:$/, '');
  if (opts.requireHttps ? scheme !== 'https' : scheme !== 'http' && scheme !== 'https') return false;
  if (url.username || url.password || url.hash) return false;
  return !isBlockedHostname(url.hostname.replace(/^\[|\]$/g, ''));
}
