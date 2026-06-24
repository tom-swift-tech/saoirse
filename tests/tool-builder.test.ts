// Tier-1 gate: a built tool is ACCRETED (sandboxed), never live, until a human
// approves it through the token-gated promotion. These tests use a faux builder
// (never real pi) and assert the gate is structural: the build path cannot write
// skills/, and only the explicit, token-checked promotion can.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readdirSync,
} from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { SaoirseCore } from '../src/core/saoirse.js';
import {
  safeToolName,
  type BuildResult,
  type ToolBuilder,
  type ToolSpec,
} from '../src/core/tool-builder.js';
import { PiToolBuilder } from '../src/core/pi-tool-builder.js';
import { resolveInside } from '../src/core/sandbox.js';
import {
  approveProposal,
  rejectProposal,
  readProposals,
  writeProposal,
} from '../src/proposals.js';
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

/** A faux builder that writes a real artifact into the sandbox (no pi). */
function fauxBuilder(sandboxRoot: string): ToolBuilder {
  return {
    async build(spec: ToolSpec): Promise<BuildResult> {
      const toolName = safeToolName(spec.name);
      const id = `${toolName}-faux`;
      const sandboxDir = resolveInside(sandboxRoot, id);
      await mkdir(sandboxDir, { recursive: true });
      await writeFile(
        join(sandboxDir, 'index.ts'),
        'export const run = () => "hi";\n',
      );
      return {
        ok: true,
        id,
        toolName,
        sandboxDir,
        files: ['index.ts'],
        diff: '+ index.ts',
        testOutput: 'ok',
        rationale: 'satisfies the spec',
      };
    },
  };
}

let root: string;
let proposalsDir: string;
let skillsDir: string;
let sandboxRoot: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'saoirse-tier1-'));
  proposalsDir = join(root, 'proposals');
  skillsDir = join(root, 'skills');
  sandboxRoot = join(root, 'sandbox');
  for (const d of [proposalsDir, skillsDir, sandboxRoot]) mkdirSync(d);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('handleBuildRequest — accretes, never promotes', () => {
  it('writes a pending proposal and does NOT touch skills/', async () => {
    const core = new SaoirseCore(new FakeMemory(), new FakeGateway(), {
      builder: fauxBuilder(sandboxRoot),
      proposalsDir,
    });

    const outcome = await core.handleBuildRequest({
      name: 'weather',
      description: 'fetch the weather',
    });

    expect(outcome).toMatchObject({
      ok: true,
      status: 'pending',
      toolName: 'weather',
    });
    const queue = await readProposals(proposalsDir);
    expect(queue.count).toBe(1);
    const record = JSON.parse(queue.proposals[0].content);
    expect(record.status).toBe('pending');
    expect(record.tier).toBe(1);
    // skills/ is untouched — nothing went live
    expect(readdirSync(skillsDir)).toHaveLength(0);
  });

  it('emits proposal.queued (tier 1) after a successful build', async () => {
    // Inject a fake sink so we can assert the event without a real transport.
    const sink = fakeEventSink();
    const core = new SaoirseCore(
      new FakeMemory(),
      new FakeGateway(),
      { builder: fauxBuilder(sandboxRoot), proposalsDir },
      undefined,
      undefined,
      sink,
    );

    const outcome = await core.handleBuildRequest({ name: 'weather', description: 'd' });
    if (!outcome.ok) throw new Error('build failed in test');

    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]).toMatchObject({
      type: 'proposal.queued',
      id: outcome.proposalId,
      tier: 1,
    });
    // kind is not set for tier-1 tool proposals
    expect((sink.events[0] as { kind?: unknown }).kind).toBeUndefined();
  });

  it('does NOT emit when the build fails', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const sink = fakeEventSink();
    const failing: ToolBuilder = {
      async build() { throw new Error('pi blew up'); },
    };
    const core = new SaoirseCore(
      new FakeMemory(),
      new FakeGateway(),
      { builder: failing, proposalsDir },
      undefined,
      undefined,
      sink,
    );

    await core.handleBuildRequest({ name: 'x', description: 'y' });

    expect(sink.events).toHaveLength(0);
    spy.mockRestore();
  });

  it('logs a build failure and leaves capabilities + skills unchanged (no swallow)', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failing: ToolBuilder = {
      async build() {
        throw new Error('pi blew up');
      },
    };
    const core = new SaoirseCore(new FakeMemory(), new FakeGateway(), {
      builder: failing,
      proposalsDir,
    });

    const outcome = await core.handleBuildRequest({
      name: 'x',
      description: 'y',
    });

    expect(outcome.ok).toBe(false);
    expect(spy).toHaveBeenCalled(); // logged, not swallowed
    expect((await readProposals(proposalsDir)).count).toBe(0);
    expect(readdirSync(skillsDir)).toHaveLength(0);
    // the running message loop is entirely unaffected
    const reply = await core.handleMessage('still works?');
    expect(reply.reply).toBe('pong');
    spy.mockRestore();
  });

  it('throws when tool-building is not configured', async () => {
    const core = new SaoirseCore(new FakeMemory(), new FakeGateway());
    expect(core.canBuildTools).toBe(false);
    await expect(
      core.handleBuildRequest({ name: 'x', description: 'y' }),
    ).rejects.toThrow(/not configured/);
  });
});

describe('promotion gate (the ONLY skills/ writer)', () => {
  async function seedProposal(): Promise<string> {
    const core = new SaoirseCore(new FakeMemory(), new FakeGateway(), {
      builder: fauxBuilder(sandboxRoot),
      proposalsDir,
    });
    const outcome = await core.handleBuildRequest({
      name: 'weather',
      description: 'fetch the weather',
    });
    if (!outcome.ok) throw new Error('seed failed');
    return outcome.proposalId;
  }

  it('approve copies the sandbox artifact into skills/ and dequeues', async () => {
    const id = await seedProposal();
    const result = await approveProposal(id, {
      proposalsDir,
      skillsDir,
      sandboxRoot,
    });
    expect(result.toolName).toBe('weather');
    expect(existsSync(join(skillsDir, 'weather', 'index.ts'))).toBe(true);
    expect((await readProposals(proposalsDir)).count).toBe(0);
  });

  it('reject discards the sandbox artifact and dequeues; skills untouched', async () => {
    const id = await seedProposal();
    const record = JSON.parse(
      (await readProposals(proposalsDir)).proposals[0].content,
    );
    expect(existsSync(record.sandboxDir)).toBe(true);

    await rejectProposal(id, { proposalsDir, sandboxRoot });

    expect(existsSync(record.sandboxDir)).toBe(false);
    expect((await readProposals(proposalsDir)).count).toBe(0);
    expect(readdirSync(skillsDir)).toHaveLength(0);
  });

  it('refuses to promote an artifact that lives OUTSIDE the sandbox', async () => {
    const evil = join(root, 'evil');
    mkdirSync(evil);
    writeFileSync(join(evil, 'pwn.ts'), 'malware');
    await writeProposal(proposalsDir, {
      id: 'evil-1',
      status: 'pending',
      tier: 1,
      toolName: 'evil',
      spec: { name: 'evil', description: 'x' },
      sandboxDir: evil, // not under sandboxRoot
      files: ['pwn.ts'],
      rationale: '',
      diff: '',
      testOutput: '',
    });

    await expect(
      approveProposal('evil-1', { proposalsDir, skillsDir, sandboxRoot }),
    ).rejects.toThrow(/outside the sandbox/);
    expect(readdirSync(skillsDir)).toHaveLength(0);
  });
});

describe('sandbox containment', () => {
  it('resolveInside rejects escapes and allows nested paths', () => {
    expect(() => resolveInside(sandboxRoot, '../escape')).toThrow(/escapes/);
    expect(() => resolveInside(sandboxRoot, '/etc/passwd')).toThrow(/escapes/);
    expect(resolveInside(sandboxRoot, 'tool/inner.ts')).toContain('inner.ts');
  });

  it('safeToolName rejects path-traversal names', () => {
    expect(() => safeToolName('..')).toThrow();
    expect(safeToolName('My Weather Tool!')).toBe('my-weather-tool');
  });
});

describe('PiToolBuilder (stand-in pi command, never real pi)', () => {
  // A tiny script that speaks the assumed pi contract over stdin/stdout.
  function fakePi(files: string): string {
    const script = join(root, 'fakepi.cjs');
    writeFileSync(
      script,
      `let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{` +
        `process.stdout.write(JSON.stringify({ok:true,files:${files},diff:'d',testOutput:'t',rationale:'r'}))});`,
    );
    return `node ${script}`;
  }

  it('writes the proposed files into the sandbox', async () => {
    const builder = new PiToolBuilder({
      command: fakePi(`[{"path":"index.ts","content":"export const x=1;"}]`),
      sandboxRoot,
    });
    const result = await builder.build({ name: 'demo', description: 'd' });
    expect(result.ok).toBe(true);
    expect(existsSync(join(result.sandboxDir, 'index.ts'))).toBe(true);
    // and that artifact is inside the sandbox root
    expect(result.sandboxDir.startsWith(resolveInside(sandboxRoot, '.'))).toBe(
      true,
    );
  });

  it('rejects a file path that escapes the sandbox', async () => {
    const builder = new PiToolBuilder({
      command: fakePi(`[{"path":"../../escape.ts","content":"x"}]`),
      sandboxRoot,
    });
    await expect(
      builder.build({ name: 'evil', description: 'd' }),
    ).rejects.toThrow(/escapes/);
    expect(existsSync(join(root, 'escape.ts'))).toBe(false);
  });
});
