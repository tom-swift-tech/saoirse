// Integration test for the websearch skill: spawns run.mjs against a local
// stub HTTP server so no real SearXNG instance is needed.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { spawn } from 'node:child_process';

// ---------------------------------------------------------------------------
// Stub SearXNG server
// ---------------------------------------------------------------------------

const CANNED_RESULTS = [
  { title: 'Hello World - Wikipedia', url: 'https://en.wikipedia.org/wiki/Hello_world', content: 'A hello world program is a computer program.' },
  { title: 'Hello World Examples', url: 'https://example.com/hello', content: 'Examples in every language.' },
];

let server: Server;
let baseUrl: string;

beforeAll(
  () =>
    new Promise<void>((resolve) => {
      server = createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        if (url.pathname !== '/search') {
          res.writeHead(404);
          res.end('not found');
          return;
        }
        const q = url.searchParams.get('q') ?? '';
        // Return empty results for the special sentinel query.
        const results = q === 'no-results-sentinel' ? [] : CANNED_RESULTS;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ results }));
      });

      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as { port: number };
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    }),
);

afterAll(
  () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
    }),
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function runSkill(
  input: unknown,
  env: NodeJS.ProcessEnv = {},
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ['skills/websearch/run.mjs'],
      {
        cwd: 'D:/projects/saoirse',
        env: { ...process.env, SEARXNG_URL: baseUrl, ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d));
    child.stderr.on('data', (d: Buffer) => (stderr += d));

    child.on('close', (code) => resolve({ stdout, stderr, code }));

    child.stdin.write(JSON.stringify(input));
    child.stdin.end();
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('websearch skill', () => {
  it('returns a formatted numbered list on a normal response', async () => {
    const { stdout, code } = await runSkill({ query: 'hello' });
    expect(code).toBe(0);
    // Both canned results should appear.
    expect(stdout).toMatch(/1\. Hello World - Wikipedia/);
    expect(stdout).toMatch(/https:\/\/en\.wikipedia\.org\/wiki\/Hello_world/);
    expect(stdout).toMatch(/2\. Hello World Examples/);
    expect(stdout).toMatch(/https:\/\/example\.com\/hello/);
  });

  it('respects the count parameter and clips to it', async () => {
    const { stdout, code } = await runSkill({ query: 'hello', count: 1 });
    expect(code).toBe(0);
    expect(stdout).toMatch(/^1\./m);
    // Second result must NOT appear.
    expect(stdout).not.toMatch(/^2\./m);
  });

  it('prints "No results found" and exits 0 when the API returns an empty array', async () => {
    const { stdout, code } = await runSkill({ query: 'no-results-sentinel' });
    expect(code).toBe(0);
    expect(stdout).toMatch(/No results found for: "no-results-sentinel"/);
  });

  it('exits non-zero and mentions SEARXNG_URL when the endpoint is unreachable', async () => {
    // Port 1 is reserved and will always be refused.
    const { stderr, code } = await runSkill(
      { query: 'hello' },
      { SEARXNG_URL: 'http://127.0.0.1:1' },
    );
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/SEARXNG_URL/);
  });

  it('exits 1 with a clear message when query is missing', async () => {
    const { stderr, code } = await runSkill({});
    expect(code).toBe(1);
    expect(stderr).toMatch(/query/);
  });

  it('exits 1 with a clear message when query is an empty string', async () => {
    const { stderr, code } = await runSkill({ query: '   ' });
    expect(code).toBe(1);
    expect(stderr).toMatch(/query/);
  });

  it('handles a BOM-prefixed stdin (PowerShell quirk)', async () => {
    // Write a BOM + JSON directly rather than going through runSkill helper.
    const { stdout, code } = await new Promise<{
      stdout: string;
      stderr: string;
      code: number | null;
    }>((resolve) => {
      const child = spawn(
        process.execPath,
        ['skills/websearch/run.mjs'],
        {
          cwd: 'D:/projects/saoirse',
          env: { ...process.env, SEARXNG_URL: baseUrl },
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d: Buffer) => (stdout += d));
      child.stderr.on('data', (d: Buffer) => (stderr += d));
      child.on('close', (code) => resolve({ stdout, stderr, code }));

      // BOM (U+FEFF) prepended to the JSON.
      const bom = '﻿';
      child.stdin.write(bom + JSON.stringify({ query: 'hello' }));
      child.stdin.end();
    });

    expect(code).toBe(0);
    expect(stdout).toMatch(/1\. Hello World/);
  });
});
