// The HTTP channel is a thin transport: it parses, dispatches to the core, and
// serializes. Driven over a real socket with faux seams behind the core.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createRouter } from '../src/channels/http.js';
import { SaoirseCore } from '../src/core/saoirse.js';
import type { Memory, RecalledContext, Exchange } from '../src/core/memory.js';
import type { ModelGateway } from '../src/core/model-gateway.js';

class FakeMemory implements Memory {
  async recall(): Promise<RecalledContext> {
    return { text: '', sessionId: 's', reason: 'new', count: 0 };
  }
  async retain(_exchange: Exchange): Promise<void> {}
  close(): void {}
}

class FakeGateway implements ModelGateway {
  async complete(): Promise<string> {
    return 'pong';
  }
}

const proposalsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'proposals',
);

// Shared status stub includes the new embeddings field.
const stubStatus = async () => ({
  model: { name: 'stub', endpoint: 'http://x/v1', reachable: false },
  skills: { count: 0, names: [] },
  version: 'test',
  embeddings: { mode: 'offline', reachable: null as boolean | null },
});

// Two server fixtures: one with no token (open routes only), one with a token.
let server: http.Server;
let base: string;
let tokenServer: http.Server;
let tokenBase: string;
const VALID_TOKEN = 'correct-horse-battery';

beforeAll(async () => {
  const core = new SaoirseCore(new FakeMemory(), new FakeGateway());

  // No-token fixture — open routes only.
  server = http.createServer(
    createRouter({
      core,
      proposalsDir,
      skillsDir: proposalsDir,
      sandboxDir: proposalsDir,
      packageJsonPath: proposalsDir,
      engramEvalSandbox: proposalsDir,
      engramAuthorSandbox: proposalsDir,
      token: undefined,
      status: stubStatus,
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;

  // Token-enabled fixture — for privileged-route auth tests.
  tokenServer = http.createServer(
    createRouter({
      core,
      proposalsDir,
      skillsDir: proposalsDir,
      sandboxDir: proposalsDir,
      packageJsonPath: proposalsDir,
      engramEvalSandbox: proposalsDir,
      engramAuthorSandbox: proposalsDir,
      token: VALID_TOKEN,
      status: stubStatus,
    }),
  );
  await new Promise<void>((resolve) => tokenServer.listen(0, resolve));
  tokenBase = `http://localhost:${(tokenServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await new Promise<void>((resolve) => tokenServer.close(() => resolve()));
});

describe('HTTP channel', () => {
  it('POST /message returns a reply (reply field unchanged; recall added additively)', async () => {
    const res = await fetch(`${base}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: "what's new" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    // reply contract is intact for existing clients
    expect(body).toMatchObject({ reply: 'pong' });
    // additive recall telemetry
    expect(body.recall).toEqual({ count: 0 });
  });

  it('GET /status returns model + version + embeddings field', async () => {
    const res = await fetch(`${base}/status`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      model: { name: 'stub', endpoint: 'http://x/v1', reachable: false },
      version: 'test',
    });
    // New: embeddings field must be present.
    expect(body.embeddings).toEqual({ mode: 'offline', reachable: null });
  });

  it('POST /message rejects empty text', async () => {
    const res = await fetch(`${base}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('GET /proposals returns the empty queue shape', async () => {
    const res = await fetch(`${base}/proposals`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ count: 0, proposals: [] });
  });

  // ------------------------------------------------------------------
  // Token / auth hardening
  // ------------------------------------------------------------------

  it('privileged route POST /build → 401 when no token configured', async () => {
    // The no-token server fails closed: no token configured means every
    // privileged route is rejected regardless of what the client sends.
    const res = await fetch(`${base}/build`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer anything' },
      body: JSON.stringify({ name: 'x', description: 'y' }),
    });
    expect(res.status).toBe(401);
  });

  it('privileged route POST /build → 401 with wrong token', async () => {
    const res = await fetch(`${tokenBase}/build`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer wrong-token' },
      body: JSON.stringify({ name: 'x', description: 'y' }),
    });
    expect(res.status).toBe(401);
  });

  it('privileged route POST /build → passes auth with correct token (503 from stub since PI_COMMAND unset)', async () => {
    // Auth passes; the route then 503s because canBuildTools is false on the stub core.
    const res = await fetch(`${tokenBase}/build`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${VALID_TOKEN}`,
      },
      body: JSON.stringify({ name: 'x', description: 'y' }),
    });
    // 503 means the token was accepted — if 401 the constant-time check failed.
    expect(res.status).toBe(503);
  });

  // ------------------------------------------------------------------
  // Body size cap
  // ------------------------------------------------------------------

  it('POST /message → 413 when body exceeds 1 MiB', async () => {
    // /message is unauthenticated, making it the highest-risk OOM target.
    const oversized = JSON.stringify({ text: 'x'.repeat(1024 * 1024 + 1) });
    const res = await fetch(`${base}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: oversized,
    });
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(typeof body.error).toBe('string');
  });
});
