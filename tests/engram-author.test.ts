// Tier-0 authoring (author-only): pi authors a LOCAL branch that passed Engram's
// suite, captured as an ACCRETED reviewable record. It is NOT re-pinnable, so
// approve returns 501; reject discards the clone. A faux author stands in for
// real git/pi (the same precedent as the faux tool builder).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createRouter } from '../src/channels/http.js';
import { SaoirseCore } from '../src/core/saoirse.js';
import type {
  AuthorResult,
  EngramAuthor,
  EngramChangeSpec,
} from '../src/core/engram-author.js';
import { rejectEngramAuthor, readProposals } from '../src/proposals.js';
import type { Memory } from '../src/core/memory.js';
import type { ModelGateway } from '../src/core/model-gateway.js';

const TOKEN = 'privileged-token';
const REPO = 'git+https://github.com/tom-swift-tech/engram.git';
const BASE = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

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

/** A faux author: no git, no pi. Writes a clone dir so reject can clean it. */
function fauxAuthor(sandboxRoot: string, ok: boolean): EngramAuthor {
  return {
    async author(_spec: EngramChangeSpec): Promise<AuthorResult> {
      const id = 'engram-author-faux';
      const sandboxDir = join(sandboxRoot, id);
      await mkdir(sandboxDir, { recursive: true });
      await writeFile(join(sandboxDir, 'marker'), 'clone');
      return {
        ok,
        id,
        branch: `saoirse/author-${id}`,
        baseSha: BASE,
        localSha: ok ? 'cafebabecafebabecafebabecafebabecafebabe' : '',
        sandboxDir,
        testResult: ok
          ? { passed: 340, failed: 0, total: 340 }
          : { passed: 1, failed: 2, total: 3 },
        testOutput: 'faux',
        diff: ok ? '--- a/x\n+++ b/x\n@@ +1 @@\n+change' : '',
        rationale: ok ? 'authored' : 'rejected',
        error: ok ? undefined : 'authored change did not clear the gate',
      };
    },
  };
}

let root: string;
let proposalsDir: string;
let authorSandbox: string;

function makeCore(opts: { wire?: boolean; ok?: boolean } = {}): SaoirseCore {
  const wire = opts.wire ?? true;
  return new SaoirseCore(new FakeMemory(), new FakeGateway(), undefined, undefined, {
    evaluator: { evaluate: async () => ({}) as never },
    author: wire ? fauxAuthor(authorSandbox, opts.ok ?? true) : undefined,
    proposalsDir,
    currentSha: BASE,
    baselineTestCount: 334,
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'saoirse-author-'));
  proposalsDir = join(root, 'proposals');
  authorSandbox = join(root, 'engram-author');
  mkdirSync(proposalsDir);
  mkdirSync(authorSandbox);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('handleEngramAuthorRequest — accretes a reviewable record, never publishes', () => {
  it('writes a pending kind:author record on success', async () => {
    const core = makeCore({ ok: true });
    const outcome = await core.handleEngramAuthorRequest({ description: 'do X' });
    expect(outcome).toMatchObject({ ok: true, status: 'pending' });

    const queue = await readProposals(proposalsDir);
    expect(queue.count).toBe(1);
    const record = JSON.parse(queue.proposals[0].content);
    expect(record.tier).toBe(0);
    expect(record.kind).toBe('author');
    expect(record.description).toBe('do X');
    expect(record.diff).toContain('+change');
  });

  it('logs a rejected author and queues nothing (no swallow)', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const core = makeCore({ ok: false });
    const outcome = await core.handleEngramAuthorRequest({ description: 'bad' });
    expect(outcome.ok).toBe(false);
    expect(spy).toHaveBeenCalled();
    expect((await readProposals(proposalsDir)).count).toBe(0);
    spy.mockRestore();
  });

  it('throws when authoring is not configured', async () => {
    const core = makeCore({ wire: false });
    expect(core.canAuthorEngram).toBe(false);
    await expect(
      core.handleEngramAuthorRequest({ description: 'x' }),
    ).rejects.toThrow(/not configured/);
  });
});

describe('rejectEngramAuthor', () => {
  it('discards the clone and dequeues', async () => {
    const core = makeCore({ ok: true });
    const { proposalId } = (await core.handleEngramAuthorRequest({
      description: 'do X',
    })) as { proposalId: string };
    const cloneDir = join(authorSandbox, 'engram-author-faux');
    expect(existsSync(cloneDir)).toBe(true);

    await rejectEngramAuthor(proposalId, {
      proposalsDir,
      authorSandboxRoot: authorSandbox,
    });

    expect(existsSync(cloneDir)).toBe(false);
    expect((await readProposals(proposalsDir)).count).toBe(0);
  });
});

describe('HTTP — /engram/author and approve dispatch', () => {
  let server: http.Server;
  let base: string;

  function start(core: SaoirseCore): Promise<void> {
    const packageJsonPath = join(root, 'package.json');
    writeFileSync(
      packageJsonPath,
      JSON.stringify({ dependencies: { engram: `${REPO}#${BASE}` } }, null, 2),
    );
    server = http.createServer(
      createRouter({
        core,
        proposalsDir,
        skillsDir: join(root, 'skills'),
        sandboxDir: join(root, 'sandbox'),
        packageJsonPath,
        engramEvalSandbox: join(root, 'engram-eval'),
        engramAuthorSandbox: authorSandbox,
        token: TOKEN,
        status: async () => ({
          model: { name: 'm', endpoint: 'e', reachable: false },
          skills: { count: 0, names: [] },
          version: '0',
        }),
      }),
    );
    return new Promise((r) =>
      server.listen(0, () => {
        base = `http://localhost:${(server.address() as AddressInfo).port}`;
        r();
      }),
    );
  }

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

  afterEach(async () => {
    if (server) await new Promise<void>((r) => server.close(() => r()));
  });

  it('rejects /engram/author without the token', async () => {
    await start(makeCore({ ok: true }));
    const res = await post('/engram/author', { description: 'x' });
    expect(res.status).toBe(401);
  });

  it('503s when authoring is not configured', async () => {
    await start(makeCore({ wire: false }));
    const res = await post('/engram/author', { description: 'x' }, TOKEN);
    expect(res.status).toBe(503);
  });

  it('accretes an author record, and approve on it returns 501 (publish deferred)', async () => {
    await start(makeCore({ ok: true }));
    const authored = await (
      await post('/engram/author', { description: 'do X' }, TOKEN)
    ).json();
    expect(authored.ok).toBe(true);

    // approve must NOT re-pin an authored change — it isn't publishable yet.
    const approve = await post(`/proposals/${authored.proposalId}/approve`, undefined, TOKEN);
    expect(approve.status).toBe(501);
    // the package.json pin is untouched
    expect(
      JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).dependencies.engram,
    ).toBe(`${REPO}#${BASE}`);
    // still queued (not consumed by a failed approve)
    expect((await (await fetch(`${base}/proposals`)).json()).count).toBe(1);
  });

  it('reject on an author record discards it', async () => {
    await start(makeCore({ ok: true }));
    const authored = await (
      await post('/engram/author', { description: 'do X' }, TOKEN)
    ).json();
    const res = await post(`/proposals/${authored.proposalId}/reject`, undefined, TOKEN);
    expect(res.status).toBe(200);
    expect((await (await fetch(`${base}/proposals`)).json()).count).toBe(0);
  });
});
