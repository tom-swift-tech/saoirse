// ssrf-guard.mjs — SSRF protection for the webfetch skill.
//
// webfetch fetches a model-supplied URL. A scheme check (http/https) alone does
// NOT stop the model from being steered into internal targets — cloud metadata
// (169.254.169.254), the daemon's own loopback services, Ollama, NATS, or
// tailnet peers. This module resolves the host to its actual IP(s) and refuses
// any address that is loopback / link-local / private / CGNAT / multicast /
// reserved, BEFORE the request goes out — and re-validates every redirect hop
// (redirect: 'manual'), so a public URL can't bounce to an internal one.
//
// Test-only escape hatch: safeFetch(allowPrivate:true) skips the address check
// so the integration tests can hit a localhost server. This is safe by
// construction in production: the skill runner grants skills a deny-by-default
// env (skill-runner.ts), and the daemon only grants SEARXNG_URL — it never
// passes WEBFETCH_ALLOW_PRIVATE_HOSTS, so the live skill can never enable it.

import { lookup } from 'node:dns/promises';

const MAX_REDIRECTS = 5;

// IPv4 CIDR blocks that must never be fetched. [network, prefixBits].
const V4_BLOCKS = [
  ['0.0.0.0', 8], // "this network" / unspecified
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // CGNAT (Tailscale uses this range)
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local (incl. 169.254.169.254 cloud metadata)
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved
  ['255.255.255.255', 32], // broadcast
];

function ipv4ToInt(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let int = 0;
  for (const p of parts) {
    const n = Number(p);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    int = (int * 256 + n) >>> 0;
  }
  return int >>> 0;
}

function isBlockedV4(ip) {
  const addr = ipv4ToInt(ip);
  if (addr === null) return true; // unparseable → refuse
  for (const [base, bits] of V4_BLOCKS) {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    const baseInt = ipv4ToInt(base);
    if (((addr & mask) >>> 0) === ((baseInt & mask) >>> 0)) return true;
  }
  return false;
}

function isBlockedV6(ip) {
  const a = ip.toLowerCase();
  if (a === '::1' || a === '::') return true; // loopback / unspecified
  if (/^fe[89ab]/.test(a)) return true; // link-local fe80::/10
  if (/^f[cd]/.test(a)) return true; // unique-local fc00::/7
  if (a.startsWith('ff')) return true; // multicast ff00::/8
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(a);
  if (mapped) return isBlockedV4(mapped[1]); // IPv4-mapped → check the v4
  return false;
}

/** True if `ip` is a non-public address webfetch must refuse. Exported for tests. */
export function isBlockedAddress(ip) {
  if (typeof ip !== 'string' || !ip) return true;
  return ip.includes(':') ? isBlockedV6(ip) : isBlockedV4(ip);
}

/** Resolve `hostname` and throw if ANY resolved address is non-public. */
export async function assertPublicHost(hostname) {
  let addrs;
  try {
    addrs = await lookup(hostname, { all: true });
  } catch (err) {
    throw new Error(`DNS lookup failed for "${hostname}": ${err.message}`);
  }
  if (!addrs.length) throw new Error(`no addresses resolved for "${hostname}"`);
  for (const { address } of addrs) {
    if (isBlockedAddress(address)) {
      throw new Error(
        `refusing to fetch "${hostname}": resolves to non-public address ${address} (SSRF guard)`,
      );
    }
  }
}

/**
 * fetch() with SSRF protection: validates scheme + resolved address on the
 * initial URL and on every redirect hop (manual redirects, capped). Returns
 * { response, finalUrl }. Throws on a blocked host, bad scheme, or redirect
 * overflow. allowPrivate (test-only) skips the address check.
 */
export async function safeFetch(initialUrl, options = {}) {
  const { maxRedirects = MAX_REDIRECTS, allowPrivate = false, ...fetchOpts } =
    options;
  let url = initialUrl;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`unsupported scheme "${parsed.protocol}"`);
    }
    if (!allowPrivate) await assertPublicHost(parsed.hostname);

    const response = await fetch(url, { ...fetchOpts, redirect: 'manual' });

    const isRedirect = response.status >= 300 && response.status < 400;
    const location = response.headers.get('location');
    if (isRedirect && location) {
      url = new URL(location, url).href; // resolve relative redirects
      continue;
    }
    return { response, finalUrl: url };
  }
  throw new Error(`too many redirects (> ${maxRedirects})`);
}
