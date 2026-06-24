// webfetch — committed-skill entry. Fetches a URL and returns its readable
// text to the model. Pairs with websearch: search → pick a result → fetch it.
// Args arrive as JSON on stdin:
//   { url: string, maxChars?: number }
//
// Exit 0 → stdout is the page text (title + final URL + body).
// Exit 1 → stderr describes the failure; the runner surfaces it to the model.
//
// Security: only http:/https: schemes are allowed, AND the host must resolve to
// a public address — safeFetch (ssrf-guard.mjs) blocks loopback/link-local/
// private/CGNAT/multicast targets (cloud metadata, the daemon's own services,
// Ollama, NATS, tailnet peers) and re-validates every redirect hop. A broader
// egress policy (host allowlist, forward proxy) is still the Primitive-1 work.

import { extractReadable } from './extract.mjs';
import { safeFetch } from './ssrf-guard.mjs';

const DEFAULT_MAX_CHARS = 8_000;
const MAX_CHARS_CAP = 20_000;
const FETCH_TIMEOUT_MS = 10_000;

// Test-only: lets the integration suite hit a localhost stub server. Safe in
// production by construction — the skill runner grants a deny-by-default env and
// the daemon never passes this key, so the live skill can never enable it.
const ALLOW_PRIVATE = process.env.WEBFETCH_ALLOW_PRIVATE_HOSTS === '1';

// Read all of stdin, stripping a leading UTF-8 BOM that PowerShell may emit.
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => (raw += chunk));
process.stdin.on('end', () => {
  const stripped = raw.replace(/^﻿/, '');

  let args;
  try {
    args = JSON.parse(stripped || '{}');
  } catch {
    process.stderr.write('webfetch: stdin is not valid JSON\n');
    process.exit(1);
  }

  const { url, maxChars } = args;
  if (typeof url !== 'string' || !url.trim()) {
    process.stderr.write('webfetch: "url" must be a non-empty string\n');
    process.exit(1);
  }

  // Validate the URL and restrict to http/https to block scheme abuse (SSRF
  // via file:, data:, ftp:, etc.). A full egress policy is deferred to
  // Primitive-1/proxy work.
  let parsed;
  try {
    parsed = new URL(url.trim());
  } catch {
    process.stderr.write(`webfetch: invalid URL: ${url}\n`);
    process.exit(1);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    process.stderr.write(
      `webfetch: unsupported scheme "${parsed.protocol}" — only http: and https: are allowed\n`,
    );
    process.exit(1);
  }

  const limit =
    typeof maxChars === 'number'
      ? Math.min(Math.max(1, Math.floor(maxChars)), MAX_CHARS_CAP)
      : DEFAULT_MAX_CHARS;

  run(parsed.href, limit).catch((err) => {
    process.stderr.write(`webfetch: unexpected error: ${err.message}\n`);
    process.exit(1);
  });
});

async function run(url, maxChars) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  // safeFetch validates the scheme AND the resolved address (SSRF guard) on the
  // initial URL and every redirect hop, returning the final response + URL.
  let resp;
  let finalUrl;
  try {
    ({ response: resp, finalUrl } = await safeFetch(url, {
      signal: controller.signal,
      // Some sites 403 on a missing or bot-like UA; use a plain browser string.
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; webfetch-skill/1.0)' },
      allowPrivate: ALLOW_PRIVATE,
    }));
  } catch (err) {
    const reason = err.name === 'AbortError'
      ? `timed out after ${FETCH_TIMEOUT_MS}ms`
      : err.message;
    process.stderr.write(`webfetch: could not fetch ${url}: ${reason}\n`);
    process.exit(1);
  } finally {
    clearTimeout(timer);
  }

  if (!resp.ok) {
    process.stderr.write(
      `webfetch: ${url} returned HTTP ${resp.status} ${resp.statusText}\n`,
    );
    process.exit(1);
  }

  const contentType = resp.headers.get('content-type') ?? '';
  const mimeBase = contentType.split(';')[0].trim().toLowerCase();

  let body;
  try {
    body = await resp.text();
  } catch (err) {
    process.stderr.write(`webfetch: failed to read response body: ${err.message}\n`);
    process.exit(1);
  }

  let title = '';
  let text;

  if (mimeBase.includes('html')) {
    // HTML — strip tags and extract readable prose via extract.mjs.
    ({ title, text } = extractReadable(body, { maxChars }));
  } else if (mimeBase.startsWith('text/')) {
    // Other text types (plain, markdown, csv, …) — return raw, truncated.
    text = body.length > maxChars
      ? body.slice(0, maxChars).trimEnd() + '\n…(truncated)'
      : body;
  } else {
    // Binary or unsupported (image/*, application/pdf, …) — reject clearly.
    process.stderr.write(`webfetch: unsupported content-type: ${mimeBase}\n`);
    process.exit(1);
  }

  // Header: title (or the URL when there's no title) + final URL + blank line.
  const header = `${title || finalUrl}\n${finalUrl}\n\n`;
  process.stdout.write(header + text + '\n');
  process.exit(0);
}
