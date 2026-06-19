// =============================================================================
// engram-author.ts — The Engram-Author seam (Tier 0, authoring half).
//
// The evaluator (engram-evaluator.ts) CONSUMES a candidate ref; this PRODUCES
// one. Saoirse drives pi to write an Engram source change, but author-only: pi
// edits a sandbox CLONE, the change is committed to a LOCAL branch and captured
// as a diff that passed Engram's own suite. Nothing is pushed. Making that branch
// installable (push to ENGRAM_PUSH_REMOTE, then hand the SHA to the evaluate→repin
// gate) is a separate, deferred, human-gated step — see the TODO below.
//
// Unlike pi-build.mjs (which collects every file in a fresh scratch dir — right
// for a NEW skill), authoring edits an EXISTING repo in place, so the daemon owns
// all git + sandbox containment and captures the change via `git diff`. The pi
// adapter only runs the coding agent in the clone. Mirrors the ToolBuilder seam:
// an interface the core depends on, with a configured concrete impl.
// =============================================================================

import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolveInside } from './sandbox.js';
import { runCommand, tail } from './exec.js';
import {
  assertSafeRef,
  assertSafeRepo,
  isEngramCandidateAcceptable,
  parseTestSummary,
  type EngramTestResult,
} from './engram-evaluator.js';

export interface EngramChangeSpec {
  /** What the change should accomplish — handed to pi. */
  description: string;
  /** Optional extra command that must also pass in the clone after the edit. */
  test?: string;
}

export interface AuthorResult {
  /** Whether pi made a non-empty change AND it cleared the acceptance gate. */
  ok: boolean;
  /** Stable id; also the sandbox sub-directory name. */
  id: string;
  /** The local branch pi's commit landed on. */
  branch: string;
  /** The SHA the clone started from (the live pin). */
  baseSha: string;
  /** The committed SHA of pi's change (LOCAL only — not on any remote). */
  localSha: string;
  /** Absolute clone directory (inside the author sandbox root). */
  sandboxDir: string;
  testResult: EngramTestResult;
  testOutput: string;
  /** Unified diff baseSha..HEAD — the reviewable artifact. */
  diff: string;
  rationale: string;
  error?: string;
}

export interface EngramAuthor {
  author(spec: EngramChangeSpec): Promise<AuthorResult>;
}

export interface PiEngramAuthorConfig {
  /** The pi-author launcher (PI_AUTHOR_COMMAND), split on spaces for args. */
  command: string;
  /** Clone source — the Engram git repo URL (git+ prefix stripped if present). */
  repoUrl: string;
  /** The SHA to base the change on (the live pin). */
  baseSha: string;
  /** Sandbox root for author clones. Nothing is written outside it. */
  sandboxRoot: string;
  /** Known-good test-count floor a change must still meet to be accepted. */
  baselineTestCount: number;
  /** Ceiling on one clone+pi+install+test cycle, ms. */
  timeoutMs?: number;
}

/**
 * The real author: clones Engram, runs pi in the clone, commits the change to a
 * local branch, and runs Engram's own suite. Shells out to git/npm and spawns
 * the pi adapter; writes strictly inside the sandbox root. Never pushes.
 */
export class PiEngramAuthor implements EngramAuthor {
  constructor(private readonly config: PiEngramAuthorConfig) {}

  async author(spec: EngramChangeSpec): Promise<AuthorResult> {
    const id = `engram-author-${randomUUID().slice(0, 8)}`;
    const branch = `saoirse/author-${id}`;
    const sandboxDir = resolveInside(this.config.sandboxRoot, id);
    const repo = this.config.repoUrl.replace(/^git\+/, '');
    const baseSha = this.config.baseSha;
    assertSafeRepo(repo);
    assertSafeRef(baseSha);
    assertSafeRef(branch);

    const base: AuthorResult = {
      ok: false,
      id,
      branch,
      baseSha,
      localSha: '',
      sandboxDir,
      testResult: { passed: 0, failed: 0, total: 0 },
      testOutput: '',
      diff: '',
      rationale: '',
    };

    try {
      await mkdir(this.config.sandboxRoot, { recursive: true });
      await this.git(['clone', '--', repo, sandboxDir], this.config.sandboxRoot);
      await this.git(['checkout', '--detach', baseSha, '--'], sandboxDir);
      await this.git(['checkout', '-b', branch, '--'], sandboxDir);

      // pi edits the clone in place (cwd = clone, pre-`npm ci` so no node_modules
      // to confuse it). The adapter returns only a rationale — the daemon owns git.
      const pi = await this.invokePi(spec, sandboxDir);
      base.rationale = pi.rationale ?? '';
      if (!pi.ok) {
        base.error = pi.error ?? 'pi authoring failed';
        return base;
      }

      // Capture the change. An empty change is a failed author, not a no-op pass.
      await this.git(['add', '-A'], sandboxDir);
      const status = await this.git(['status', '--porcelain'], sandboxDir);
      if (!status.trim()) {
        base.error = 'pi made no changes to the Engram source';
        return base;
      }
      await this.git(
        [
          '-c',
          'user.name=Saoirse',
          '-c',
          'user.email=saoirse@local',
          'commit',
          '-m',
          `saoirse: ${spec.description}`.slice(0, 200),
        ],
        sandboxDir,
      );
      base.localSha = (await this.git(['rev-parse', 'HEAD'], sandboxDir)).trim();
      base.diff = await this.git(
        ['diff', `${baseSha}..HEAD`, '--'],
        sandboxDir,
      ).catch(() => '');

      const install = await this.run(['ci'], sandboxDir, 'npm');
      if (install.code !== 0) {
        base.testOutput = tail(install.output);
        base.error = `npm ci failed (exit ${install.code})`;
        return base;
      }
      const test = await this.run(['test'], sandboxDir, 'npm');
      base.testOutput = tail(test.output);
      base.testResult = parseTestSummary(test.output);

      // Optional spec test, then the SAME acceptance gate the evaluator uses.
      let specOk = true;
      if (spec.test) {
        const extra = await this.shell(spec.test, sandboxDir);
        base.testOutput += `\n--- spec test ---\n${tail(extra.output, 1000)}`;
        specOk = extra.code === 0;
      }
      const accepted =
        test.code === 0 &&
        specOk &&
        isEngramCandidateAcceptable(base.testResult, this.config.baselineTestCount);
      base.ok = accepted;
      base.rationale =
        (base.rationale ? base.rationale + '\n' : '') +
        (accepted
          ? `Authored on ${branch} (${base.localSha.slice(0, 7)}); suite green ` +
            `(${base.testResult.passed}/${base.testResult.total}, baseline ${this.config.baselineTestCount}).`
          : `Change rejected: exit ${test.code}, specOk=${specOk}, ` +
            `${base.testResult.failed} failed, ${base.testResult.total} run.`);
      if (!accepted && !base.error)
        base.error = 'authored change did not clear the acceptance gate';

      // TODO (publish slice): when ENGRAM_PUSH_REMOTE is configured and a human
      // approves, push `branch` there and hand its SHA to the evaluate→repin gate.
      // That is the only step that writes off the daemon host — kept separate.
      return base;
    } catch (err) {
      base.error = (err as Error).message;
      base.rationale = 'Authoring could not complete; daemon left unchanged.';
      return base;
    }
  }

  /** Run the pi-author adapter in the clone; it edits files and returns a verdict. */
  private invokePi(
    spec: EngramChangeSpec,
    cwd: string,
  ): Promise<{ ok: boolean; rationale?: string; error?: string }> {
    const [cmd, ...args] = this.config.command.split(/\s+/);
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('pi authoring timed out'));
      }, this.config.timeoutMs ?? 900_000);

      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stderr += d));
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0)
          return resolve({
            ok: false,
            error: `pi-author adapter exited ${code}: ${tail(stderr || stdout, 1000)}`,
          });
        try {
          resolve(JSON.parse(stdout));
        } catch {
          resolve({ ok: false, error: `pi-author emitted non-JSON: ${tail(stdout, 500)}` });
        }
      });

      child.stdin.write(JSON.stringify(spec));
      child.stdin.end();
    });
  }

  private async git(args: string[], cwd: string): Promise<string> {
    const { code, output } = await this.run(args, cwd, 'git');
    if (code !== 0) {
      throw new Error(`git ${args.join(' ')} failed (exit ${code}): ${tail(output, 500)}`);
    }
    return output;
  }

  private run(args: string[], cwd: string, cmd: string) {
    return runCommand(cmd, args, cwd, this.config.timeoutMs ?? 900_000);
  }

  /** A spec test command runs through a shell (it may be a pipeline). */
  private shell(command: string, cwd: string) {
    return new Promise<{ code: number; output: string }>((resolve) => {
      const child = spawn(command, { cwd, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve({ code: 1, output: `${output}\n(spec test timed out)` });
      }, this.config.timeoutMs ?? 900_000);
      child.stdout.on('data', (d) => (output += d));
      child.stderr.on('data', (d) => (output += d));
      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({ code: 1, output: `spec test spawn error: ${err.message}` });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code: code ?? 1, output });
      });
    });
  }
}
