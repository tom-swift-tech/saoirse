// =============================================================================
// engram-evaluator.ts — The Engram-Evaluator seam (Tier 0). HIGHEST GATE.
//
// Saoirse MAY read, branch, and test changes to Engram — she MAY NOT edit the
// source the live daemon is running on (SYSTEM.md Tier 0). This seam realizes
// the *evaluation* half of that promise: given a candidate Engram git ref, it
// clones that ref into a sandbox (NEVER the live node_modules), runs Engram's
// OWN test suite, and reports whether the candidate is green enough to PROPOSE.
//
// It mirrors the ToolBuilder (Tier 1) seam exactly: an interface the core
// depends on, with a configured concrete impl (git/npm) that is the only thing
// shelling out. The evaluator has NO path to package.json — re-pinning is a
// separate, human-gated action (proposals.ts approveEngramProposal). A failed
// or rejected candidate leaves the running daemon entirely unchanged.
// =============================================================================

import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolveInside } from './sandbox.js';
import { runCommand, tail, type RunResult } from './exec.js';

export interface EngramCandidate {
  /** Git ref to evaluate — a full SHA, tag, or branch on the Engram repo. */
  ref: string;
}

/** What the candidate's own test suite reported. */
export interface EngramTestResult {
  passed: number;
  failed: number;
  /** Total tests the suite reported running (passed + failed + any others). */
  total: number;
}

export interface EvalResult {
  /** Whether clone+install+test ran AND the candidate cleared the gate. */
  ok: boolean;
  /** Stable id; also the sandbox sub-directory name. */
  id: string;
  /** The ref requested. */
  candidateRef: string;
  /** The full SHA the ref resolved to (empty if clone/checkout failed). */
  candidateSha: string;
  /** The SHA the live daemon is currently pinned to. */
  currentSha: string;
  /** Absolute clone directory (inside the eval sandbox root). */
  sandboxDir: string;
  /** Parsed suite summary. Zeroed when the suite never ran. */
  testResult: EngramTestResult;
  /** Tail of captured stdout/stderr from the test run. */
  testOutput: string;
  /** Human-readable commit range currentSha..candidateSha. */
  diff: string;
  /** Why the evaluator believes this candidate does/does not clear the gate. */
  rationale: string;
  /** Populated when ok === false. */
  error?: string;
}

export interface EngramEvaluator {
  evaluate(candidate: EngramCandidate): Promise<EvalResult>;
}

// -----------------------------------------------------------------------------
// THE ACCEPTANCE PREDICATE — the literal judgment at the highest gate.
//
// This is the single function that decides whether an evaluated Engram candidate
// is green enough to even be PROPOSED to the Director. Everything downstream
// (writing the proposal, the token-gated re-pin) trusts this verdict, so the
// strictness encoded here IS the Tier-0 safety posture.
//
// The chosen rule (security over convenience): a candidate clears the gate only
// when BOTH hold —
//   1. zero failing tests, AND
//   2. it ran at least `baselineCount` tests.
// Condition (2) is the non-obvious one: a suite can "pass" with zero failures
// simply because tests silently stopped being collected (a broken glob, a
// renamed dir, a crashed setup file). Corrupted memory is silent — so a shrunken
// suite must NOT be mistaken for a healthy one. `baselineCount` is the known-good
// floor (SYSTEM.md: "334+ tests"), tunable via ENGRAM_BASELINE_TESTS.
// -----------------------------------------------------------------------------
export function isEngramCandidateAcceptable(
  result: EngramTestResult,
  baselineCount: number,
): boolean {
  // The chosen rule: zero failures AND the suite ran at least the known-good
  // floor. The explicit `total > 0` is defensive — it closes the degenerate case
  // where a misconfigured baseline of 0 would otherwise let an empty (silently
  // un-collected) suite clear the gate. A shrunken suite is never "green enough".
  return result.failed === 0 && result.total > 0 && result.total >= baselineCount;
}

/**
 * Parse a vitest summary into an EngramTestResult. Handles both the all-green
 * form ("Tests  334 passed (334)") and the mixed form
 * ("Tests  2 failed | 332 passed (334)"). Returns zeroes when no summary line is
 * found — a suite that produced no parseable summary did not demonstrably pass.
 */
export function parseTestSummary(output: string): EngramTestResult {
  const line = output
    .split('\n')
    .reverse()
    .find((l) => /\bTests\b\s+.*\b(passed|failed)\b/.test(l));
  if (!line) return { passed: 0, failed: 0, total: 0 };

  const passed = Number(/(\d+)\s+passed/.exec(line)?.[1] ?? 0);
  const failed = Number(/(\d+)\s+failed/.exec(line)?.[1] ?? 0);
  // The trailing "(N)" is vitest's authoritative total; fall back to the sum.
  const total = Number(/\((\d+)\)\s*$/.exec(line)?.[1] ?? passed + failed);
  return { passed, failed, total };
}

export interface GitEngramEvaluatorConfig {
  /** Clone source — the Engram git repo URL (git+ prefix stripped if present). */
  repoUrl: string;
  /** Sandbox root for candidate clones. Nothing is written outside it. */
  sandboxRoot: string;
  /** The SHA the live daemon is pinned to (parsed from package.json at boot). */
  currentSha: string;
  /** Known-good test-count floor; a candidate must run at least this many. */
  baselineTestCount: number;
  /** Ceiling on one full clone+install+test cycle, ms. */
  timeoutMs?: number;
}

/**
 * The real evaluator: clones a candidate ref, runs Engram's own suite, and
 * applies the acceptance predicate. Shells out to git and npm; the ONLY place in
 * the Tier-0 path that does. Writes strictly inside the sandbox root.
 */
export class GitEngramEvaluator implements EngramEvaluator {
  constructor(private readonly config: GitEngramEvaluatorConfig) {}

  async evaluate(candidate: EngramCandidate): Promise<EvalResult> {
    const ref = candidate.ref.trim();
    const id = `engram-${ref.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 24)}-${randomUUID().slice(0, 8)}`;
    const sandboxDir = resolveInside(this.config.sandboxRoot, id);
    const repo = this.config.repoUrl.replace(/^git\+/, '');
    assertSafeRef(ref);
    assertSafeRepo(repo);

    const base: EvalResult = {
      ok: false,
      id,
      candidateRef: ref,
      candidateSha: '',
      currentSha: this.config.currentSha,
      sandboxDir,
      testResult: { passed: 0, failed: 0, total: 0 },
      testOutput: '',
      diff: '',
      rationale: '',
    };

    try {
      await mkdir(this.config.sandboxRoot, { recursive: true });
      // `--` ends option parsing: even a validated ref/repo can never be read as
      // a git flag (argv flag smuggling). Validation above is the belt; `--` the
      // braces.
      await this.git(['clone', '--', repo, sandboxDir], this.config.sandboxRoot);
      await this.git(['checkout', '--detach', ref, '--'], sandboxDir);
      const candidateSha = (
        await this.git(['rev-parse', 'HEAD'], sandboxDir)
      ).trim();
      base.candidateSha = candidateSha;

      // Commit range for the proposal. Best-effort: an unrelated/missing base
      // SHA must not fail the whole evaluation, only blank the diff.
      base.diff = await this.git(
        ['log', '--oneline', `${this.config.currentSha}..${candidateSha}`, '--'],
        sandboxDir,
      ).catch(() => '');

      const install = await this.run('npm', ['ci'], sandboxDir);
      if (install.code !== 0) {
        base.testOutput = tail(install.output);
        base.error = `npm ci failed (exit ${install.code})`;
        base.rationale = 'Dependencies did not install; suite never ran.';
        return base;
      }

      const test = await this.run('npm', ['test'], sandboxDir);
      base.testOutput = tail(test.output);
      base.testResult = parseTestSummary(test.output);

      const accepted =
        test.code === 0 &&
        isEngramCandidateAcceptable(
          base.testResult,
          this.config.baselineTestCount,
        );
      base.ok = accepted;
      base.rationale = accepted
        ? `Candidate ${candidateSha.slice(0, 7)} passed Engram's own suite ` +
          `(${base.testResult.passed}/${base.testResult.total}, baseline ${this.config.baselineTestCount}).`
        : `Candidate rejected: exit ${test.code}, ${base.testResult.failed} failed, ` +
          `${base.testResult.total} run (baseline ${this.config.baselineTestCount}).`;
      if (!accepted && !base.error)
        base.error = 'candidate did not clear the Tier-0 acceptance gate';
      return base;
    } catch (err) {
      base.error = (err as Error).message;
      base.rationale = 'Evaluation could not complete; daemon left unchanged.';
      return base;
    }
  }

  private async git(args: string[], cwd: string): Promise<string> {
    const { code, output } = await this.run('git', args, cwd);
    if (code !== 0) {
      throw new Error(`git ${args.join(' ')} failed (exit ${code}): ${tail(output, 500)}`);
    }
    return output;
  }

  private run(cmd: string, args: string[], cwd: string): Promise<RunResult> {
    return runCommand(cmd, args, cwd, this.config.timeoutMs ?? 900_000);
  }
}

// A git ref: SHA, tag, or branch (branches may contain "/"). The allowlist
// excludes whitespace and shell/option metacharacters; the explicit leading-"-"
// reject stops argv flag smuggling even though "-" is legal mid-ref.
const SAFE_REF_RE = /^[A-Za-z0-9._/-]+$/;

/** Reject any ref that could be read as a git option or smuggle metacharacters. */
export function assertSafeRef(ref: string): void {
  if (!ref || ref.startsWith('-') || !SAFE_REF_RE.test(ref)) {
    throw new Error(`unsafe engram ref: "${ref}"`);
  }
}

/** The clone source must be an http(s) URL (post git+ strip), never an option. */
export function assertSafeRepo(repo: string): void {
  if (!/^https?:\/\//.test(repo)) {
    throw new Error(`unsafe engram repo url: "${repo}"`);
  }
}
