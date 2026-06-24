// The gate over the wire: /build and the promotion routes are token-gated, and
// GET /proposals surfaces what a build accretes. No real pi — a faux builder.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import { mkdtempSync, rmSync, mkdirSync, existsSync, readdirSync } from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createRouter } from '../src/channels/http.js';
import { SaoirseCore } from '../src/core/saoirse.js';
import {
  safeToolName,
  type BuildResult,
  type ToolBuilder,
  type ToolSpec,
} from '../src/core/tool-builder.js';
import { resolveInside } from '../src/core/sandbox.js';
import type { Memory } from '../src/core/memory.js';
import type { ModelGateway } from '../src/core/model-gateway.js';
import type { EventSink, SaoirseEvent } from '../src/core/events.js';

/** Minimal in-memory EventSink that records every published event. */
function fakeEventSink(): EventSink & { events: SaoirseEvent[] } {
  const events: SaoirseEvent[] = [];
  return {
    events,
    publish(event: SaoirseEvent) { events.push(event); },
  };
}

const TOKEN = 'privileged-token';

class FakeMemory implements Memory {
  async recall() {
    return { text: '', sessionId: 's', reason: 'new' as const };
  }
  async retain() {}
  close() {}
}
class FakeGateway implements ModelGateway {
  async complete() {
    return 'pong';
  }
}
function fauxBuilder(sandboxRoot: string): ToolBuilder {
  return {
    async build(spec: ToolSpec): Promise<BuildResult> {
      const toolName = safeToolName(spec.name);
      const id = `${toolName}-faux`;
      const sandboxDir = resolveInside(sandboxRoot, id);
      await mkdir(sandboxDir, { recursive: true });
      await writeFile(join(sandboxDir, 'index.ts'), 'export const run = 1;\n');
      return {
        ok: true,
        id,
        toolName,
        sandboxDir,
        files: ['index.ts'],
        diff: '+ index.ts',
        testOutput: 'ok',
        rationale: 'r',
      };
    },
  };
}

let root: string;
let proposalsDir: string;
let skillsDir: string;
let sandboxRoot: string;
let server: http.Server;
let base: string;
// Shared sink so event assertions can reach events fired inside the router.
let sink: EventSink & { events: SaoirseEvent[] };

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'saoirse-http-tier1-'));
  proposalsDir = join(root, 'proposals');
  skillsDir = join(root, 'skills');
  sandboxRoot = join(root, 'sandbox');
  for (const d of [proposalsDir, skillsDir, sandboxRoot]) mkdirSync(d);
  sink = fakeEventSink();

  const core = new SaoirseCore(new FakeMemory(), new FakeGateway(), {
    builder: fauxBuilder(sandboxRoot),
    proposalsDir,
  });
  server = http.createServer(
    createRouter({
      core,
      proposalsDir,
      skillsDir,
      sandboxDir: sandboxRoot,
      token: TOKEN,
      events: sink,
    }),
  );
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(root, { recursive: true, force: true });
});

function post(path: string, body?: unknown, token?: string) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function build(): Promise<string> {
  const res = await post(
    '/build',
    { name: 'weather', description: 'd' },
    TOKEN,
  );
  expect(res.status).toBe(200);
  return (await res.json()).proposalId;
}

describe('POST /build (token-gated)', () => {
  it('rejects without the token', async () => {
    const res = await post('/build', { name: 'x', description: 'y' });
    expect(res.status).toBe(401);
    expect(readdirSync(proposalsDir)).toHaveLength(0);
  });

  it('with the token, accretes a pending proposal surfaced by GET /proposals', async () => {
    const id = await build();
    expect(id).toContain('weather');
    const q = await (await fetch(`${base}/proposals`)).json();
    expect(q.count).toBe(1);
    expect(q.proposals[0].name).toBe(`${id}.json`);
    // nothing went live
    expect(readdirSync(skillsDir)).toHaveLength(0);
  });
});

describe('POST /proposals/:id/approve (the gate)', () => {
  it('rejects without the token and leaves skills/ empty', async () => {
    const id = await build();
    const res = await post(`/proposals/${id}/approve`);
    expect(res.status).toBe(401);
    expect(readdirSync(skillsDir)).toHaveLength(0);
  });

  it('with the token, promotes the artifact into skills/', async () => {
    const id = await build();
    const res = await post(`/proposals/${id}/approve`, undefined, TOKEN);
    expect(res.status).toBe(200);
    expect(existsSync(join(skillsDir, 'weather', 'index.ts'))).toBe(true);
    // dequeued
    const q = await (await fetch(`${base}/proposals`)).json();
    expect(q.count).toBe(0);
  });

  it('404s for an unknown proposal id', async () => {
    const res = await post('/proposals/nope/approve', undefined, TOKEN);
    expect(res.status).toBe(404);
  });
});

describe('POST /proposals/:id/reject (token-gated)', () => {
  it('with the token, discards the artifact and dequeues; skills untouched', async () => {
    const id = await build();
    const res = await post(`/proposals/${id}/reject`, undefined, TOKEN);
    expect(res.status).toBe(200);
    const q = await (await fetch(`${base}/proposals`)).json();
    expect(q.count).toBe(0);
    expect(readdirSync(skillsDir)).toHaveLength(0);
  });
});

describe('proposal.resolved events via HTTP', () => {
  it('emits proposal.resolved approved after a successful tier-1 approve', async () => {
    const id = await build();
    sink.events.length = 0; // clear the queued event from the build
    const res = await post(`/proposals/${id}/approve`, undefined, TOKEN);
    expect(res.status).toBe(200);
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]).toMatchObject({
      type: 'proposal.resolved',
      id,
      action: 'approved',
    });
  });

  it('emits proposal.resolved rejected after a successful tier-1 reject', async () => {
    const id = await build();
    sink.events.length = 0; // clear the queued event from the build
    const res = await post(`/proposals/${id}/reject`, undefined, TOKEN);
    expect(res.status).toBe(200);
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]).toMatchObject({
      type: 'proposal.resolved',
      id,
      action: 'rejected',
    });
  });

  it('does NOT emit when the token is missing (request rejected before action)', async () => {
    const id = await build();
    sink.events.length = 0;
    await post(`/proposals/${id}/approve`); // no token
    // no resolved event — the gate rejected before any action was taken
    expect(sink.events.filter((e) => e.type === 'proposal.resolved')).toHaveLength(0);
  });
});
