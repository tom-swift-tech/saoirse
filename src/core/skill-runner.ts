// =============================================================================
// skill-runner.ts — Executes a committed skill as a subprocess.
//
// A skill run is one short-lived child process: the entry script (from the
// validated manifest) is run with the SAME Node the daemon runs on
// (process.execPath — the Node-20 ABI constraint travels with us), receives the
// tool-call arguments as JSON on stdin, and must print its result to stdout.
// Stdout is the tool result handed back to the model, verbatim.
//
// Process isolation is the Tier-1 failure contract made real: a skill that
// crashes, hangs, or prints garbage fails VISIBLY and is scoped to that one
// call — the daemon and the rest of the turn carry on (SYSTEM.md Tier 1).
// =============================================================================

import { spawn } from 'node:child_process';
import type { LoadedSkill } from './skills.js';

const DEFAULT_TIMEOUT_MS = 30_000;
/** Cap on the stdout a skill may return into the model context. */
const MAX_OUTPUT_CHARS = 16_384;

/**
 * Env keys a skill subprocess inherits. The daemon's own secrets
 * (SAOIRSE_TOKEN, MODEL_ENDPOINT, NATS_URL, …) are deliberately NOT here: a
 * promoted skill gets what a fresh shell would have, nothing the daemon was
 * trusted with. A skill that legitimately needs more is granted it explicitly
 * at the wiring site (allowEnv) — inheriting is drift, granting is deliberate
 * (SYSTEM.md Tier 1). Keys are compared case-insensitively (win32 env).
 */
const SAFE_ENV_KEYS = new Set(
  [
    'PATH',
    'SYSTEMROOT', // win32: DNS resolution + crypto break without it
    'WINDIR',
    'COMSPEC',
    'PATHEXT',
    'TEMP',
    'TMP',
    'TMPDIR',
    'HOME',
    'USERPROFILE',
    'LANG',
    'LC_ALL',
    'TZ',
  ].map((k) => k.toUpperCase()),
);

/** Build a skill's env: the safe baseline plus any deliberately-granted keys. */
function skillEnv(allow: readonly string[] = []): NodeJS.ProcessEnv {
  const granted = new Set(allow.map((k) => k.toUpperCase()));
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    const upper = key.toUpperCase();
    if (SAFE_ENV_KEYS.has(upper) || granted.has(upper)) env[key] = value;
  }
  return env;
}

export interface SkillRunOutcome {
  ok: boolean;
  /** Tool result for the model: stdout on success, the failure reason otherwise. */
  output: string;
}

export interface SkillRunner {
  run(skill: LoadedSkill, argsJson: string): Promise<SkillRunOutcome>;
}

export class ProcessSkillRunner implements SkillRunner {
  constructor(
    private readonly defaults: { timeoutMs?: number; allowEnv?: string[] } = {},
  ) {}

  run(skill: LoadedSkill, argsJson: string): Promise<SkillRunOutcome> {
    const timeoutMs =
      skill.timeoutMs ?? this.defaults.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    return new Promise((resolve) => {
      const child = spawn(process.execPath, [skill.entry], {
        cwd: skill.dir,
        env: skillEnv(this.defaults.allowEnv),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      // On timeout: kill, then report from the 'close' handler — resolving only
      // after the child has fully exited (and released its handles).
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);

      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stderr += d));
      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({
          ok: false,
          output: `skill "${skill.name}" failed to start: ${err.message}`,
        });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (timedOut) {
          resolve({
            ok: false,
            output: `skill "${skill.name}" timed out after ${timeoutMs}ms`,
          });
        } else if (code === 0) {
          resolve({ ok: true, output: clamp(stdout.trim()) });
        } else {
          resolve({
            ok: false,
            output:
              `skill "${skill.name}" exited ${code}: ` +
              clamp((stderr || stdout).trim()),
          });
        }
      });

      child.stdin.write(argsJson);
      child.stdin.end();
    });
  }
}

function clamp(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return `${text.slice(0, MAX_OUTPUT_CHARS)}\n…(truncated)`;
}
