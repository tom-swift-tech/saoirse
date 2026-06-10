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

let server: http.Server;
let base: string;

beforeAll(async () => {
  const core = new SaoirseCore(new FakeMemory(), new FakeGateway());
  server = http.createServer(
    createRouter({
      core,
      proposalsDir,
      skillsDir: proposalsDir,
      sandboxDir: proposalsDir,
      token: undefined,
      status: async () => ({
        model: { name: 'stub', endpoint: 'http://x/v1', reachable: false },
        version: 'test',
      }),
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
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

  it('GET /status returns model + version, reachable reflected', async () => {
    const res = await fetch(`${base}/status`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      model: { name: 'stub', endpoint: 'http://x/v1', reachable: false },
      version: 'test',
    });
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
});
