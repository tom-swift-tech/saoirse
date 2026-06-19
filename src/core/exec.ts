// =============================================================================
// exec.ts — Shared subprocess runner for the Tier-0 git/npm paths.
//
// One place to spawn a non-shell child, capture merged stdout+stderr, and bound
// it with a hard timeout. Returns the exit code rather than throwing on non-zero
// so each caller decides what a failure MEANS: for `git` a non-zero exit is an
// error, but for `npm test` it is signal (tests failed), not an exception.
// Used by the Engram evaluator (Tier-0 gate) and author (Tier-0 authoring).
// =============================================================================

import { spawn } from 'node:child_process';

export interface RunResult {
  code: number;
  /** Merged stdout + stderr in arrival order. */
  output: string;
}

/**
 * Spawn `cmd args` in `cwd` with no shell (argv is passed verbatim — callers
 * still guard untrusted positional args with `--`). Rejects only on spawn error
 * or timeout; a non-zero exit resolves with its code.
 */
export function runCommand(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${cmd} ${args[0] ?? ''} timed out`));
    }, timeoutMs);

    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, output });
    });
  });
}

/** Keep only the last `max` characters — test logs are huge; the tail is enough. */
export function tail(text: string, max = 4000): string {
  return text.length <= max ? text : text.slice(text.length - max);
}
