// Unit tests for the webfetch SSRF address classifier. Pure function, no DNS —
// asserts which resolved IPs are refused (loopback/private/CGNAT/link-local/
// multicast/reserved + IPv4-mapped IPv6) vs allowed (genuine public addresses).
import { describe, it, expect } from 'vitest';
import { isBlockedAddress } from '../skills/webfetch/ssrf-guard.mjs';

describe('isBlockedAddress', () => {
  const blocked = [
    '127.0.0.1', // loopback
    '127.9.9.9',
    '0.0.0.0', // unspecified
    '10.0.0.1', // private
    '10.255.255.255',
    '172.16.0.1', // private (low edge)
    '172.31.255.255', // private (high edge)
    '192.168.1.1', // private
    '169.254.169.254', // link-local — cloud metadata
    '100.64.0.1', // CGNAT / Tailscale
    '224.0.0.1', // multicast
    '240.0.0.1', // reserved
    '255.255.255.255', // broadcast
    '::1', // v6 loopback
    '::', // v6 unspecified
    'fe80::1', // v6 link-local
    'fc00::1', // v6 unique-local
    'fd12:3456::1', // v6 unique-local
    'ff02::1', // v6 multicast
    '::ffff:127.0.0.1', // IPv4-mapped loopback
    '::ffff:10.0.0.5', // IPv4-mapped private
    'not-an-ip', // unparseable → refuse
    '', // empty → refuse
    '999.999.999.999', // out of range → refuse
  ];

  const allowed = [
    '1.1.1.1',
    '8.8.8.8',
    '93.184.216.34', // example.com
    '11.0.0.1', // just outside 10/8
    '172.15.0.1', // just below 172.16/12
    '172.32.0.1', // just above 172.16/12
    '192.167.0.1', // just below 192.168/16
    '100.63.255.255', // just below 100.64/10
    '2606:4700:4700::1111', // Cloudflare v6
    '::ffff:8.8.8.8', // IPv4-mapped public
  ];

  for (const ip of blocked) {
    it(`blocks ${ip || '(empty)'}`, () => {
      expect(isBlockedAddress(ip)).toBe(true);
    });
  }

  for (const ip of allowed) {
    it(`allows ${ip}`, () => {
      expect(isBlockedAddress(ip)).toBe(false);
    });
  }

  it('refuses non-string input', () => {
    // @ts-expect-error — exercising the defensive guard against undefined
    expect(isBlockedAddress(undefined)).toBe(true);
    // @ts-expect-error — exercising the defensive guard against a number
    expect(isBlockedAddress(12345)).toBe(true);
  });
});
