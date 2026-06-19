// Tier-0 over the wire: /engram/evaluate is token-gated and 503s when unwired;
// a green evaluation accretes a proposal; and the shared approve route dispatches
// a tier-0 record to the re-pin gate (rewriting a TEMP package.json, never live).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createRouter } from '../src/channels/http.js';
import { SaoirseCore } from '../src/core/saoirse.js';
import type {
  EngramCandidate,
  EngramEvaluator,
  EvalResult,
} from '../src/core/engram-evaluator.js';
import type { Memory } from '../src/core/memory.js';
import type { ModelGateway } from '../src/core/model-gateway.js';

const TOKEN = 'privileged-token';
const REPO = 'git+https://github.com/tom-swift-tech/engram.git';
const CURRENT = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const CANDIDATE = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

class FakeMemory implements Memory {
  async recall() {
    return { text: '', sessionId: 's', reason: 'new' as const, count: 0 };
  }
  async retain() {}
  close() {}
}
class FakeGateway implements ModelGateway {
  async complete() {
    return 'pong';
  }
}

/** A faux evaluator: no git, no network. Writes a clone dir so reject can clean it. */
function fauxEvaluator(sandboxRoot: string, accept: boolean): EngramEvaluator {
  return {
    async evaluate(c: EngramCandidate): Promise<EvalResult> {
      const id = `engram-${c.ref}-faux`;
      const sandboxDir = join(sandboxRoot, id);
      await mkdir(sandboxDir, { recursive: true });
      await writeFile(join(sandboxDir, 'marker'), 'clone');
      const testResult = accept
        ? { passed: 340, failed: 0, total: 340 }
        : { passed: 10, failed: 2, total: 12 };
      return {
        ok: accept,
        id,
        candidateRef: c.ref,
        candidateSha: CANDIDATE,
        currentSha: CURRENT,
        sandboxDir,
        testResult,
        testOutput: 'faux',
        diff: '+ commits',
        rationale: accept ? 'green' : 'red',
        error: accept ? undefined : 'candidate did not clear the gate',
      };
    },
  };
}

let root: string;
let proposalsDir: string;
let skillsDir: string;
let sandboxRoot: string;
let engramEvalSandbox: string;
let packageJsonPath: string;
let server: http.Server;
let base: string;

function startServer(opts: { accept?: boolean; wireEngram?: boolean } = {}): void {
  const accept = opts.accept ?? true;
  const wireEngram = opts.wireEngram ?? true;
  const core = new SaoirseCore(
    new FakeMemory(),
    new FakeGateway(),
    undefined,
    undefined,
    wireEngram
      ? {
          evaluator: fauxEvaluator(engramEvalSandbox, accept),
          proposalsDir,
          currentSha: CURRENT,
          baselineTestCount: 334,
        }
      : undefined,
  );
  server = http.createServer(
    createRouter({
      core,
      proposalsDir,
      skillsDir,
      sandboxDir: sandboxRoot,
      packageJsonPath,
      engramEvalSandbox,
      token: TOKEN,
      status: async () => ({
        model: { name: 'm', endpoint: 'e', reachable: false },
        skills: { count: 0, names: [] },
        version: '0',
      }),
    }),
  );
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'saoirse-tier0-http-'));
  proposalsDir = join(root, 'proposals');
  skillsDir = join(root, 'skills');
  sandboxRoot = join(root, 'sandbox');
  engramEvalSandbox = join(root, 'engram-eval');
  packageJsonPath = join(root, 'package.json');
  for (const d of [proposalsDir, skillsDir, sandboxRoot, engramEvalSandbox])
    mkdirSync(d);
  writeFileSync(
    packageJsonPath,
    JSON.stringify({ name: 'saoirse', dependencies: { engram: `${REPO}#${CURRENT}` } }, null, 2),
  );
});

afterEach(async () => {
  if (server) await new Promise<void>((r) => server.close(() => r()));
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

async function listen(): Promise<void> {
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
}

describe('POST /engram/evaluate (token-gated)', () => {
  it('rejects without the token; nothing queued', async () => {
    startServer();
    await listen();
    const res = await post('/engram/evaluate', { ref: CANDIDATE });
    expect(res.status).toBe(401);
    expect((await (await fetch(`${base}/proposals`)).json()).count).toBe(0);
  });

  it('503s when engram evaluation is not configured', async () => {
    startServer({ wireEngram: false });
    await listen();
    const res = await post('/engram/evaluate', { ref: CANDIDATE }, TOKEN);
    expect(res.status).toBe(503);
  });

  it('a green candidate accretes a pending tier-0 proposal', async () => {
    startServer({ accept: true });
    await listen();
    const res = await post('/engram/evaluate', { ref: CANDIDATE }, TOKEN);
    expect(res.status).toBe(200);
    const out = await res.json();
    expect(out.ok).toBe(true);
    expect(out.candidateSha).toBe(CANDIDATE);

    const q = await (await fetch(`${base}/proposals`)).json();
    expect(q.count).toBe(1);
    expect(JSON.parse(q.proposals[0].content).tier).toBe(0);
  });

  it('a red candidate returns 422 and queues nothing', async () => {
    startServer({ accept: false });
    await listen();
    const res = await post('/engram/evaluate', { ref: CANDIDATE }, TOKEN);
    expect(res.status).toBe(422);
    expect((await res.json()).ok).toBe(false);
    expect((await (await fetch(`${base}/proposals`)).json()).count).toBe(0);
  });
});

describe('POST /proposals/:id/approve dispatches tier-0 to the re-pin gate', () => {
  it('re-pins the temp package.json and dequeues', async () => {
    startServer({ accept: true });
    await listen();
    const id = (await (await post('/engram/evaluate', { ref: CANDIDATE }, TOKEN)).json())
      .proposalId;

    const res = await post(`/proposals/${id}/approve`, undefined, TOKEN);
    expect(res.status).toBe(200);
    expect((await res.json()).repinned).toBe(CANDIDATE);

    const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
    expect(pkg.dependencies.engram).toBe(`${REPO}#${CANDIDATE}`);
    expect((await (await fetch(`${base}/proposals`)).json()).count).toBe(0);
  });

  it('requires the token (the gate stays closed)', async () => {
    startServer({ accept: true });
    await listen();
    const id = (await (await post('/engram/evaluate', { ref: CANDIDATE }, TOKEN)).json())
      .proposalId;
    const res = await post(`/proposals/${id}/approve`);
    expect(res.status).toBe(401);
    // pin unchanged
    expect(JSON.parse(readFileSync(packageJsonPath, 'utf8')).dependencies.engram).toBe(
      `${REPO}#${CURRENT}`,
    );
  });
});
