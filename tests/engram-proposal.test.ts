// Tier-0 gate: a re-pin rewrites ONLY the engram dep in package.json, refuses
// when the pin drifted out from under the evaluation, and never runs install or
// restart. Operates entirely on a temp package.json — the real one is untouched.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  approveEngramProposal,
  rejectEngramProposal,
  readProposalTier,
  parseEngramPin,
  writeProposal,
  type EngramProposalRecord,
} from '../src/proposals.js';

const REPO = 'git+https://github.com/tom-swift-tech/engram.git';
const CURRENT = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const CANDIDATE = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

let root: string;
let proposalsDir: string;
let evalSandboxRoot: string;
let packageJsonPath: string;

function pkgWithPin(sha: string): string {
  return JSON.stringify(
    { name: 'saoirse', dependencies: { engram: `${REPO}#${sha}`, ws: '^8.0.0' } },
    null,
    2,
  );
}

/** Seed a Tier-0 proposal plus a real clone dir under the eval sandbox. */
async function seedEngramProposal(id = 'engram-cand-1'): Promise<string> {
  const sandboxDir = join(evalSandboxRoot, id);
  mkdirSync(sandboxDir, { recursive: true });
  writeFileSync(join(sandboxDir, 'marker'), 'clone');
  const record: EngramProposalRecord = {
    id,
    status: 'pending',
    tier: 0,
    candidateRef: CANDIDATE,
    candidateSha: CANDIDATE,
    currentSha: CURRENT,
    sandboxDir,
    testResult: { passed: 340, failed: 0, total: 340 },
    rationale: 'green',
    diff: '+ commits',
    testOutput: 'Tests  340 passed (340)',
  };
  await writeProposal(proposalsDir, record);
  return id;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'saoirse-tier0-'));
  proposalsDir = join(root, 'proposals');
  evalSandboxRoot = join(root, 'engram-eval');
  packageJsonPath = join(root, 'package.json');
  mkdirSync(proposalsDir);
  mkdirSync(evalSandboxRoot);
  writeFileSync(packageJsonPath, pkgWithPin(CURRENT));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('parseEngramPin', () => {
  it('splits repo url and sha', () => {
    expect(parseEngramPin(`${REPO}#${CURRENT}`)).toEqual({
      repoUrl: REPO,
      sha: CURRENT,
    });
  });
  it('throws on an unrecognized spec', () => {
    expect(() => parseEngramPin('^1.0.0')).toThrow(/unrecognized/);
  });
});

describe('approveEngramProposal — the ONLY engram pin writer', () => {
  it('rewrites only the engram pin and dequeues + cleans the clone', async () => {
    const id = await seedEngramProposal();
    const cloneDir = JSON.parse(
      readFileSync(join(proposalsDir, `${id}.json`), 'utf8'),
    ).sandboxDir;

    const result = await approveEngramProposal(id, {
      proposalsDir,
      packageJsonPath,
      evalSandboxRoot,
    });

    const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
    expect(pkg.dependencies.engram).toBe(`${REPO}#${CANDIDATE}`);
    expect(pkg.dependencies.ws).toBe('^8.0.0'); // nothing else touched
    expect(result.candidateSha).toBe(CANDIDATE);
    expect(result.note).toMatch(/npm install/);
    // dequeued and the clone cleaned
    expect(existsSync(join(proposalsDir, `${id}.json`))).toBe(false);
    expect(existsSync(cloneDir)).toBe(false);
  });

  it('REFUSES when package.json drifted from the evaluated base', async () => {
    const id = await seedEngramProposal();
    // The pin moved to something other than record.currentSha since evaluation.
    writeFileSync(packageJsonPath, pkgWithPin('cccccccccccccccccccccccccccccccccccccccc'));

    await expect(
      approveEngramProposal(id, { proposalsDir, packageJsonPath, evalSandboxRoot }),
    ).rejects.toThrow(/refusing to re-pin/);

    // pin unchanged, proposal still queued
    expect(JSON.parse(readFileSync(packageJsonPath, 'utf8')).dependencies.engram).toBe(
      `${REPO}#cccccccccccccccccccccccccccccccccccccccc`,
    );
    expect(existsSync(join(proposalsDir, `${id}.json`))).toBe(true);
  });
});

describe('rejectEngramProposal', () => {
  it('discards the clone and dequeues; package.json untouched', async () => {
    const id = await seedEngramProposal();
    const cloneDir = join(evalSandboxRoot, id);
    expect(existsSync(cloneDir)).toBe(true);

    await rejectEngramProposal(id, { proposalsDir, evalSandboxRoot });

    expect(existsSync(cloneDir)).toBe(false);
    expect(existsSync(join(proposalsDir, `${id}.json`))).toBe(false);
    expect(JSON.parse(readFileSync(packageJsonPath, 'utf8')).dependencies.engram).toBe(
      `${REPO}#${CURRENT}`,
    );
  });
});

describe('readProposalTier — route dispatch', () => {
  it('reports 0 for an engram proposal', async () => {
    const id = await seedEngramProposal();
    expect(await readProposalTier(proposalsDir, id)).toBe(0);
  });

  it('reports 1 for a tool proposal', async () => {
    await writeProposal(proposalsDir, {
      id: 'tool-1',
      status: 'pending',
      tier: 1,
      toolName: 'tool',
      spec: { name: 'tool', description: 'd' },
      sandboxDir: join(root, 'sandbox', 'tool-1'),
      files: [],
      rationale: '',
      diff: '',
      testOutput: '',
    });
    expect(await readProposalTier(proposalsDir, 'tool-1')).toBe(1);
  });
});
