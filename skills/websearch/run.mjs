// websearch — committed-skill entry. Searches the web via a self-hosted
// SearXNG instance (zero-API-cost). Args arrive as JSON on stdin:
//   { query: string, count?: number }
//
// SEARXNG_URL env var — defaults to http://localhost:8888 if unset. Point it
// at wherever your SearXNG instance lives. The daemon grants this key
// explicitly; it is not a secret.
//
// SearXNG JSON API: GET <url>/search?q=<encoded>&format=json
// Response: { results: [{ title, url, content }, ...] }
//
// Exit 0 → stdout is the tool result (results list or "No results" message).
// Exit 1 → stderr describes the failure; the runner surfaces it to the model.

const SEARXNG_URL = process.env.SEARXNG_URL ?? 'http://localhost:8888';
const DEFAULT_COUNT = 5;
const MAX_COUNT = 10;
const FETCH_TIMEOUT_MS = 10_000;

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
    process.stderr.write('websearch: stdin is not valid JSON\n');
    process.exit(1);
  }

  const { query, count } = args;
  if (typeof query !== 'string' || !query.trim()) {
    process.stderr.write('websearch: "query" must be a non-empty string\n');
    process.exit(1);
  }

  const limit = typeof count === 'number'
    ? Math.min(Math.max(1, Math.floor(count)), MAX_COUNT)
    : DEFAULT_COUNT;

  run(query.trim(), limit).catch((err) => {
    process.stderr.write(`websearch: unexpected error: ${err.message}\n`);
    process.exit(1);
  });
});

async function run(query, limit) {
  const searchUrl =
    `${SEARXNG_URL}/search?q=${encodeURIComponent(query)}&format=json`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let resp;
  try {
    resp = await fetch(searchUrl, { signal: controller.signal });
  } catch (err) {
    const reason = err.name === 'AbortError'
      ? `timed out after ${FETCH_TIMEOUT_MS}ms`
      : err.message;
    process.stderr.write(
      `websearch: could not reach SearXNG at ${SEARXNG_URL}: ${reason}\n` +
      `  Check that SearXNG is running and SEARXNG_URL is correct.\n`,
    );
    process.exit(1);
  } finally {
    clearTimeout(timer);
  }

  if (!resp.ok) {
    process.stderr.write(
      `websearch: SearXNG returned HTTP ${resp.status} ${resp.statusText}\n` +
      `  URL: ${searchUrl}\n`,
    );
    process.exit(1);
  }

  let body;
  try {
    body = await resp.json();
  } catch {
    process.stderr.write('websearch: SearXNG response is not valid JSON\n');
    process.exit(1);
  }

  const results = Array.isArray(body?.results) ? body.results : [];
  if (results.length === 0) {
    process.stdout.write(`No results found for: "${query}"\n`);
    process.exit(0);
  }

  const top = results.slice(0, limit);
  const lines = top.map((r, i) => {
    const title = r.title ?? '(no title)';
    const url = r.url ?? '(no url)';
    const snippet = (r.content ?? '').trim() || '(no snippet)';
    return `${i + 1}. ${title}\n   ${url}\n   ${snippet}`;
  });

  process.stdout.write(lines.join('\n\n') + '\n');
  process.exit(0);
}
