// Integration test for the webfetch skill: spawns run.mjs against a local
// stub HTTP server so no real network calls are needed.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { spawn } from 'node:child_process';

// ---------------------------------------------------------------------------
// Stub HTTP server
// ---------------------------------------------------------------------------

// A small HTML page: has a title, a <script> block to strip, and prose to keep.
const SAMPLE_HTML = `<!DOCTYPE html>
<html>
<head>
  <title>Test Page Title</title>
  <script>window.__SECRET = "strip_me";</script>
  <style>body { color: red; }</style>
</head>
<body>
  <h1>Hello from the stub</h1>
  <p>This is readable prose that the model should see.</p>
  <p>Second paragraph with more content here.</p>
  <script>console.log("also strip this script");</script>
</body>
</html>`;

let server: Server;
let port: number;

beforeAll(
  () =>
    new Promise<void>((resolve) => {
      server = createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost');

        if (url.pathname === '/') {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(SAMPLE_HTML);
          return;
        }

        if (url.pathname === '/plain') {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('Just plain text content.');
          return;
        }

        if (url.pathname === '/notfound') {
          res.writeHead(404, { 'Content-Type': 'text/html' });
          res.end('<html><body>Not Found</body></html>');
          return;
        }

        if (url.pathname === '/binary') {
          res.writeHead(200, { 'Content-Type': 'application/pdf' });
          res.end('%PDF-1.4 fake binary');
          return;
        }

        res.writeHead(404);
        res.end('not found');
      });

      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as { port: number };
        port = addr.port;
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
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ['skills/webfetch/run.mjs'],
      {
        cwd: 'D:/projects/saoirse',
        env: { ...process.env },
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

describe('webfetch skill', () => {
  it('returns readable prose and strips script/style noise from HTML', async () => {
    const { stdout, code } = await runSkill({ url: `http://127.0.0.1:${port}/` });
    expect(code).toBe(0);
    // Title and prose must appear.
    expect(stdout).toMatch(/Test Page Title/);
    expect(stdout).toMatch(/readable prose that the model should see/);
    expect(stdout).toMatch(/Second paragraph/);
    // Script contents must be stripped.
    expect(stdout).not.toMatch(/strip_me/);
    expect(stdout).not.toMatch(/also strip this script/);
    // Style contents must be stripped.
    expect(stdout).not.toMatch(/color: red/);
  });

  it('includes the URL in the output header', async () => {
    const { stdout, code } = await runSkill({ url: `http://127.0.0.1:${port}/` });
    expect(code).toBe(0);
    expect(stdout).toMatch(new RegExp(`127\\.0\\.0\\.1:${port}`));
  });

  it('exits non-zero and prints HTTP status on a non-2xx response', async () => {
    const { stderr, code } = await runSkill({ url: `http://127.0.0.1:${port}/notfound` });
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/404/);
  });

  it('exits non-zero with a clear message for a non-http scheme', async () => {
    const { stderr, code } = await runSkill({ url: 'file:///etc/passwd' });
    expect(code).toBe(1);
    expect(stderr).toMatch(/unsupported scheme/);
    expect(stderr).toMatch(/file:/);
  });

  it('rejects data: URLs', async () => {
    const { stderr, code } = await runSkill({ url: 'data:text/html,<h1>hi</h1>' });
    expect(code).toBe(1);
    expect(stderr).toMatch(/unsupported scheme/);
  });

  it('exits non-zero and names the URL when the host is unreachable', async () => {
    // Port 1 is reserved and will always be refused immediately.
    const { stderr, code } = await runSkill({ url: 'http://127.0.0.1:1/' });
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/127\.0\.0\.1:1/);
  });

  it('returns text/plain responses as-is without HTML extraction', async () => {
    const { stdout, code } = await runSkill({ url: `http://127.0.0.1:${port}/plain` });
    expect(code).toBe(0);
    expect(stdout).toMatch(/Just plain text content/);
  });

  it('exits non-zero with unsupported content-type for binary responses', async () => {
    const { stderr, code } = await runSkill({ url: `http://127.0.0.1:${port}/binary` });
    expect(code).toBe(1);
    expect(stderr).toMatch(/unsupported content-type/);
    expect(stderr).toMatch(/application\/pdf/);
  });

  it('exits 1 with a clear message when url is missing', async () => {
    const { stderr, code } = await runSkill({});
    expect(code).toBe(1);
    expect(stderr).toMatch(/url/);
  });

  it('exits 1 with a clear message when url is an empty string', async () => {
    const { stderr, code } = await runSkill({ url: '   ' });
    expect(code).toBe(1);
    expect(stderr).toMatch(/url/);
  });

  it('exits 1 on invalid (non-parseable) URL', async () => {
    const { stderr, code } = await runSkill({ url: 'not a url at all' });
    expect(code).toBe(1);
    expect(stderr).toMatch(/invalid URL/i);
  });

  it('handles a BOM-prefixed stdin (PowerShell quirk)', async () => {
    // Write BOM + JSON directly without the helper.
    const { stdout, code } = await new Promise<{
      stdout: string;
      stderr: string;
      code: number | null;
    }>((resolve) => {
      const child = spawn(
        process.execPath,
        ['skills/webfetch/run.mjs'],
        {
          cwd: 'D:/projects/saoirse',
          env: { ...process.env },
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d: Buffer) => (stdout += d));
      child.stderr.on('data', (d: Buffer) => (stderr += d));
      child.on('close', (code) => resolve({ stdout, stderr, code }));

      // BOM (U+FEFF) prepended to the JSON — simulates PowerShell stdin pipe.
      const bom = '﻿';
      child.stdin.write(bom + JSON.stringify({ url: `http://127.0.0.1:${port}/` }));
      child.stdin.end();
    });

    expect(code).toBe(0);
    expect(stdout).toMatch(/Test Page Title/);
  });
});
