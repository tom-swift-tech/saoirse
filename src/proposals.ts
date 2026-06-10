// =============================================================================
// proposals.ts — The governance queue: read, write, and the GATED promotion.
//
// Crossing a Tier-0 (Engram source) or Tier-1 (tools/skills) boundary requires a
// written proposal placed in proposals/. readProposals() reads that queue;
// writeProposal() enqueues a pending one. approveProposal() is the ONLY function
// in the system that writes into the live skills/ directory, and it is invoked
// from exactly one place — the token-gated POST /proposals/:id/approve route.
// There is no other path from a sandboxed build to a live capability.
// README.md and dotfiles are documentation, not proposals.
// =============================================================================

import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'fs/promises';
import { join } from 'path';
import { isInside, resolveInside } from './core/sandbox.js';
import { validateSkillDir } from './core/skills.js';

export interface Proposal {
  name: string;
  content: string;
}

export interface ProposalQueue {
  count: number;
  proposals: Proposal[];
}

/** The structured record persisted as proposals/<id>.json. */
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

/** Enqueue a pending proposal as proposals/<id>.json. Writes nothing to skills/. */
export async function writeProposal(
  proposalsDir: string,
  record: ToolProposalRecord,
): Promise<string> {
  await mkdir(proposalsDir, { recursive: true });
  const file = join(proposalsDir, `${record.id}.json`);
  await writeFile(file, JSON.stringify(record, null, 2), 'utf8');
  return record.id;
}

async function loadRecord(
  proposalsDir: string,
  id: string,
): Promise<{ path: string; record: ToolProposalRecord }> {
  // resolveInside keeps a malicious id (e.g. "../../etc") from escaping the queue.
  const path = `${resolveInside(proposalsDir, `${id}.json`)}`;
  const record = JSON.parse(await readFile(path, 'utf8')) as ToolProposalRecord;
  return { path, record };
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
  const { record } = await loadRecord(deps.proposalsDir, id);

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
  const { record } = await loadRecord(deps.proposalsDir, id);
  if (record.sandboxDir && isInside(deps.sandboxRoot, record.sandboxDir)) {
    await rm(record.sandboxDir, { recursive: true, force: true });
  }
  await rm(join(deps.proposalsDir, `${id}.json`), { force: true });
  console.log(`[saoirse] rejected proposal ${id} — discarded sandbox artifact`);
  return { id };
}
