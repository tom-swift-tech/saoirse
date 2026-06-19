// =============================================================================
// proposals.ts — The governance queue: read, write, and the GATED promotions.
//
// Crossing a Tier-0 (Engram source) or Tier-1 (tools/skills) boundary requires a
// written proposal placed in proposals/. readProposals() reads that queue;
// writeProposal() enqueues a pending one. There are exactly two promotion
// writers in the whole system, each reachable from exactly one token-gated
// route:
//   - approveProposal()        (Tier 1) — the ONLY writer of the live skills/ dir.
//   - approveEngramProposal()  (Tier 0) — the ONLY writer of the engram pin in
//                                          package.json.
// Neither mutates the running process: a promoted skill loads on next start; a
// re-pinned Engram loads only after a deliberate `npm install` + restart.
// README.md and dotfiles are documentation, not proposals.
// =============================================================================

import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'fs/promises';
import { join } from 'path';
import { isInside, resolveInside } from './core/sandbox.js';
import { validateSkillDir } from './core/skills.js';
import type { EngramTestResult } from './core/engram-evaluator.js';

export interface Proposal {
  name: string;
  content: string;
}

export interface ProposalQueue {
  count: number;
  proposals: Proposal[];
}

/** A Tier-1 (tool/skill) record persisted as proposals/<id>.json. */
export interface ToolProposalRecord {
  id: string;
  status: 'pending';
  tier: 1;
  toolName: string;
  spec: { name: string; description: string; test?: string };
  /** Absolute sandbox directory holding the accreted (un-promoted) artifact. */
  sandboxDir: string;
  files: string[];
  rationale: string;
  diff: string;
  testOutput: string;
}

/** A Tier-0 re-pin record (evaluate→repin) persisted as proposals/<id>.json. */
export interface EngramProposalRecord {
  id: string;
  status: 'pending';
  tier: 0;
  /** Distinguishes a re-pin proposal from an authored-change record. */
  kind: 'repin';
  /** The candidate git ref that was evaluated. */
  candidateRef: string;
  /** The full SHA the ref resolved to — what package.json would be re-pinned to. */
  candidateSha: string;
  /** The SHA the daemon was pinned to AT EVALUATION TIME. The re-pin refuses if
   *  package.json no longer matches this (the pin drifted underneath us). */
  currentSha: string;
  /** Absolute sandbox clone the candidate was evaluated in. */
  sandboxDir: string;
  testResult: EngramTestResult;
  rationale: string;
  diff: string;
  testOutput: string;
}

/**
 * A Tier-0 authored-change record (authoring half). It is ACCRETED — a reviewable
 * diff on a LOCAL branch that passed Engram's suite, NOT re-pinnable: localSha is
 * on no remote, so package.json cannot point at it. Making it installable (push +
 * evaluate→repin) is the deferred publish step; until then approve returns 501.
 */
export interface EngramAuthorRecord {
  id: string;
  status: 'pending';
  tier: 0;
  kind: 'author';
  description: string;
  /** Local branch pi's commit landed on (e.g. saoirse/author-<id>). */
  branch: string;
  /** The pin the change was based on. */
  baseSha: string;
  /** pi's committed SHA — LOCAL ONLY, not on any remote. */
  localSha: string;
  /** Absolute sandbox clone holding the branch. */
  sandboxDir: string;
  testResult: EngramTestResult;
  rationale: string;
  diff: string;
  testOutput: string;
}

/** Any governance record; discriminated on `tier` and (for tier 0) `kind`. */
export type ProposalRecord =
  | ToolProposalRecord
  | EngramProposalRecord
  | EngramAuthorRecord;

export interface PromotionDeps {
  proposalsDir: string;
  skillsDir: string;
  /** Sandbox root — promotion/rejection only touch artifacts proven to live here. */
  sandboxRoot: string;
}

export async function readProposals(dir: string): Promise<ProposalQueue> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    // No proposals directory yet — an empty queue, not an error.
    return { count: 0, proposals: [] };
  }

  const proposals: Proposal[] = [];
  for (const name of entries.sort()) {
    if (name.startsWith('.') || name.toLowerCase() === 'readme.md') continue;
    const full = join(dir, name);
    const info = await stat(full);
    if (!info.isFile()) continue;
    proposals.push({ name, content: await readFile(full, 'utf8') });
  }

  return { count: proposals.length, proposals };
}

/** Enqueue a pending proposal as proposals/<id>.json. Promotes nothing. */
export async function writeProposal(
  proposalsDir: string,
  record: ProposalRecord,
): Promise<string> {
  await mkdir(proposalsDir, { recursive: true });
  const file = join(proposalsDir, `${record.id}.json`);
  await writeFile(file, JSON.stringify(record, null, 2), 'utf8');
  return record.id;
}

async function loadRecord<T extends ProposalRecord = ProposalRecord>(
  proposalsDir: string,
  id: string,
): Promise<{ path: string; record: T }> {
  // resolveInside keeps a malicious id (e.g. "../../etc") from escaping the queue.
  const path = `${resolveInside(proposalsDir, `${id}.json`)}`;
  const record = JSON.parse(await readFile(path, 'utf8')) as T;
  return { path, record };
}

/**
 * Read the routing of a queued proposal — tier, plus the tier-0 `kind` — so a
 * single approve/reject route dispatches to the correct gate. Throws ENOENT
 * (→ 404) if absent. `kind` is undefined for Tier-1 records.
 */
export async function readProposalRouting(
  proposalsDir: string,
  id: string,
): Promise<{ tier: 0 | 1; kind?: 'repin' | 'author' }> {
  const { record } = await loadRecord(proposalsDir, id);
  return record.tier === 0
    ? { tier: 0, kind: record.kind }
    : { tier: 1 };
}

/**
 * THE GATE. Promote a pending proposal: copy its sandboxed artifact into the
 * live skills/ directory, then remove it from the queue. The ONLY writer of
 * skills/. Callers MUST have already verified the SAOIRSE_TOKEN — this function
 * is reachable from exactly one route. Defensively re-validates that the
 * artifact lives inside the sandbox and the destination inside skills/.
 */
export async function approveProposal(
  id: string,
  deps: PromotionDeps,
): Promise<{ toolName: string; skillDir: string; warning?: string }> {
  const { record } = await loadRecord<ToolProposalRecord>(deps.proposalsDir, id);

  if (!isInside(deps.sandboxRoot, record.sandboxDir)) {
    throw new Error(
      `refusing to promote: artifact ${record.sandboxDir} is outside the sandbox`,
    );
  }
  // Destination is a single safe segment inside skills/.
  const skillDir = resolveInside(deps.skillsDir, record.toolName);

  await mkdir(deps.skillsDir, { recursive: true });
  await cp(record.sandboxDir, skillDir, { recursive: true });

  await rm(join(deps.proposalsDir, `${id}.json`), { force: true });
  console.log(
    `[saoirse] promoted tool '${record.toolName}' (proposal ${id}) -> ${skillDir} — loads on next start`,
  );

  // Advisory: the artifact was human-approved either way, but a skill the
  // loader will skip at next boot should be heard about NOW, not as a silent
  // no-op later.
  const manifestProblem = await validateSkillDir(skillDir, record.toolName);
  if (manifestProblem) {
    const warning = `promoted, but it will NOT load as a skill: ${manifestProblem}`;
    console.warn(`[saoirse] '${record.toolName}': ${warning}`);
    return { toolName: record.toolName, skillDir, warning };
  }
  return { toolName: record.toolName, skillDir };
}

/** Discard a pending proposal: delete the sandbox artifact and dequeue it. Never touches skills/. */
export async function rejectProposal(
  id: string,
  deps: Pick<PromotionDeps, 'proposalsDir' | 'sandboxRoot'>,
): Promise<{ id: string }> {
  const { record } = await loadRecord<ToolProposalRecord>(deps.proposalsDir, id);
  if (record.sandboxDir && isInside(deps.sandboxRoot, record.sandboxDir)) {
    await rm(record.sandboxDir, { recursive: true, force: true });
  }
  await rm(join(deps.proposalsDir, `${id}.json`), { force: true });
  console.log(`[saoirse] rejected proposal ${id} — discarded sandbox artifact`);
  return { id };
}

// =============================================================================
// Tier 0 — the Engram pin. HIGHEST GATE.
// =============================================================================

/** Matches package.json's engram dep: a git URL ending in engram.git, then #<sha>. */
const ENGRAM_PIN_RE = /^(git\+https?:\/\/.+?engram\.git)(?:#(.+))?$/;

export interface EngramPin {
  /** The git URL, including any leading `git+`. */
  repoUrl: string;
  /** The pinned ref/SHA, or '' if the dep carries no #suffix. */
  sha: string;
}

/**
 * Parse the `dependencies.engram` spec into its repo URL and pinned SHA. The
 * single source of truth for "what is the daemon running on" — used at boot
 * (index.ts) and re-validated at the gate. Throws on an unrecognized spec rather
 * than guess: the pin is load-bearing.
 */
export function parseEngramPin(spec: string): EngramPin {
  const m = ENGRAM_PIN_RE.exec(spec.trim());
  if (!m) throw new Error(`unrecognized engram dependency spec: "${spec}"`);
  return { repoUrl: m[1], sha: m[2] ?? '' };
}

export interface EngramPromotionDeps {
  proposalsDir: string;
  /** Absolute path to the package.json whose engram pin is rewritten. */
  packageJsonPath: string;
  /** Eval sandbox root — clones cleaned on approve/reject must live inside it. */
  evalSandboxRoot: string;
}

/**
 * THE TIER-0 GATE. Re-pin Engram to a human-approved candidate by rewriting the
 * `engram` dependency in package.json — the ONLY writer of that pin. Callers
 * MUST have verified SAOIRSE_TOKEN; reachable from exactly one route.
 *
 * Refuses if package.json's current pin no longer equals the SHA captured at
 * evaluation time (`record.currentSha`): the base drifted, so the evaluation no
 * longer describes this re-pin. Does NOT run `npm install` and does NOT restart
 * — the running daemon keeps importing the old Engram from node_modules until a
 * deliberate reinstall + restart. That separation is the structural guarantee.
 */
export async function approveEngramProposal(
  id: string,
  deps: EngramPromotionDeps,
): Promise<{
  candidateSha: string;
  currentSha: string;
  packageJsonPath: string;
  note: string;
}> {
  const { record } = await loadRecord<EngramProposalRecord>(
    deps.proposalsDir,
    id,
  );
  if (record.tier !== 0 || record.kind !== 'repin') {
    throw new Error(`proposal ${id} is not a Tier-0 re-pin proposal`);
  }

  const raw = await readFile(deps.packageJsonPath, 'utf8');
  const pkg = JSON.parse(raw) as { dependencies?: Record<string, string> };
  const spec = pkg.dependencies?.engram;
  if (!spec) {
    throw new Error('package.json has no dependencies.engram to re-pin');
  }
  const pin = parseEngramPin(spec);

  // The drift guard — the Tier-0 analog of "artifact isInside sandbox".
  if (pin.sha !== record.currentSha) {
    throw new Error(
      `refusing to re-pin: package.json is pinned to ${pin.sha || '(none)'}, ` +
        `but this proposal was evaluated against ${record.currentSha}`,
    );
  }

  pkg.dependencies!.engram = `${pin.repoUrl}#${record.candidateSha}`;
  await writeFile(
    deps.packageJsonPath,
    JSON.stringify(pkg, null, 2) + '\n',
    'utf8',
  );

  if (isInside(deps.evalSandboxRoot, record.sandboxDir)) {
    await rm(record.sandboxDir, { recursive: true, force: true });
  }
  await rm(join(deps.proposalsDir, `${id}.json`), { force: true });

  console.log(
    `[saoirse] re-pinned engram ${record.currentSha.slice(0, 7)} -> ` +
      `${record.candidateSha.slice(0, 7)} (proposal ${id}) — ` +
      `run \`npm install\` (Node 20) and restart to load`,
  );
  return {
    candidateSha: record.candidateSha,
    currentSha: record.currentSha,
    packageJsonPath: deps.packageJsonPath,
    note: 'package.json re-pinned; run `npm install` (Node 20) and restart the daemon to load it',
  };
}

/** Discard a pending Tier-0 proposal: delete the clone and dequeue. Never touches package.json. */
export async function rejectEngramProposal(
  id: string,
  deps: Pick<EngramPromotionDeps, 'proposalsDir' | 'evalSandboxRoot'>,
): Promise<{ id: string }> {
  const { record } = await loadRecord<EngramProposalRecord>(
    deps.proposalsDir,
    id,
  );
  if (record.sandboxDir && isInside(deps.evalSandboxRoot, record.sandboxDir)) {
    await rm(record.sandboxDir, { recursive: true, force: true });
  }
  await rm(join(deps.proposalsDir, `${id}.json`), { force: true });
  console.log(`[saoirse] rejected engram proposal ${id} — discarded clone`);
  return { id };
}

/** Discard a pending authored-change record: delete the clone (it holds the
 *  local branch) and dequeue. Never pushes, never touches package.json. */
export async function rejectEngramAuthor(
  id: string,
  deps: { proposalsDir: string; authorSandboxRoot: string },
): Promise<{ id: string }> {
  const { record } = await loadRecord<EngramAuthorRecord>(deps.proposalsDir, id);
  if (record.sandboxDir && isInside(deps.authorSandboxRoot, record.sandboxDir)) {
    await rm(record.sandboxDir, { recursive: true, force: true });
  }
  await rm(join(deps.proposalsDir, `${id}.json`), { force: true });
  console.log(`[saoirse] rejected engram author record ${id} — discarded clone`);
  return { id };
}
