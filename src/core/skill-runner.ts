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
//
// Primitive 1 enforcement (skill-permissions.ts): secrets are injected from
// the SecretStore into the subprocess env on a per-declaration basis, and fs/exec
// are sandboxed via Node's permission model for any skill that carries grants
// (hasGrants). Skills that declare no permissions run exactly as before —
// the deny-by-default baseline is preserved and the change is backward-compatible.
// =============================================================================

import { spawn } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LoadedSkill } from './skills.js';
import type { SecretStore } from './secret-store.js';
import { hasGrants } from './skill-permissions.js';

const DEFAULT_TIMEOUT_MS = 30_000;
/** Cap on the stdout a skill may return into the model context. */
const MAX_OUTPUT_CHARS = 16_384;

/**
 * Env keys a skill subprocess inherits. The daemon's own secrets
 * (SAOIRSE_TOKEN, MODEL_ENDPOINT, NATS_URL, …) are deliberately NOT here: a
 * promoted skill gets what a fresh shell would have, nothing the daemon was
 * trusted with. A skill that legitimately needs more is granted it explicitly
 * at the wiring site (allowEnv) or in its permissions block — inheriting is
 * drift, granting is deliberate (SYSTEM.md Tier 1). Keys are compared
 * case-insensitively (win32 env).
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

/**
 * Build a skill's env: the safe baseline plus any deliberately-granted keys,
 * plus injected secrets from the store for each name the skill declared.
 *
 * `allowEnv` — legacy/global passthrough (runner-level).
 * `grantEnv`  — per-skill env keys from permissions.env.
 * `secrets`   — logical names from permissions.secrets; values come from the
 *               store if present. A declared-but-missing secret logs a warning
 *               (never a crash — the skill will fail its own way if it cares).
 */
function skillEnv(
  allow: readonly string[] = [],
  grantEnv: readonly string[] = [],
  secretNames: readonly string[] = [],
  secretStore?: SecretStore,
): NodeJS.ProcessEnv {
  const granted = new Set([...allow, ...grantEnv].map((k) => k.toUpperCase()));
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    const upper = key.toUpperCase();
    if (SAFE_ENV_KEYS.has(upper) || granted.has(upper)) env[key] = value;
  }

  // Inject declared secrets from the store. The store is the only authoritative
  // source; SAOIRSE_SECRET_* was already scrubbed from process.env at boot and
  // is not in SAFE_ENV_KEYS — it cannot leak through the baseline.
  for (const name of secretNames) {
    if (secretStore?.has(name)) {
      env[name] = secretStore.get(name)!;
    } else {
      console.warn(
        `[skill-runner] secret "${name}" declared by skill but not found in the store — ` +
          `the skill will run without it`,
      );
    }
  }

  return env;
}

/**
 * Resolve a path that may use `~` to the real home directory.
 * Node's permission model needs concrete paths, not shell expansions.
 */
function resolveHome(p: string): string {
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : p;
}

/**
 * Expand a set of paths into repeated `--allow-fs-read=<path>` (or write)
 * flags. Node 20.20+ deprecated the comma-separated form; repeated flags are
 * the stable interface and avoid the deprecation warning.
 */
function fsFlags(
  flag: string,
  base: readonly string[],
  extras: readonly string[],
): string[] {
  return [...base, ...extras.map(resolveHome)].map((p) => `${flag}=${p}`);
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
    private readonly defaults: {
      timeoutMs?: number;
      allowEnv?: string[];
      secretStore?: SecretStore;
    } = {},
  ) {}

  run(skill: LoadedSkill, argsJson: string): Promise<SkillRunOutcome> {
    const timeoutMs =
      skill.timeoutMs ?? this.defaults.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const permissions = skill.permissions;

    // Build the subprocess env for this skill: baseline + granted env keys +
    // injected secrets. Secrets live ONLY in this subprocess's env, scoped to
    // the one call — they are never in the daemon's env after boot-time scrub.
    const env = skillEnv(
      this.defaults.allowEnv,
      permissions.env,
      permissions.secrets,
      this.defaults.secretStore,
    );

    // Build the node argv. For skills that request any grant, prepend the
    // permission model flags so the subprocess is sandboxed. Skills with no
    // grants (the deny-all default) skip sandboxing entirely — this is the
    // backward-compatible path: their behavior is unchanged.
    //
    // Note (win32): --experimental-permission works on Node 20 on Windows, but
    // path separators in --allow-fs-read/write must be native backslashes for the
    // permission model to recognize them correctly. We rely on Node's own tmpdir()
    // and join() which already return native paths on win32; declared paths that
    // use forward slashes are passed as-is and may not match on Windows.
    const nodeArgs: string[] = [];
    if (hasGrants(permissions)) {
      const tmp = tmpdir();

      // The skill dir MUST be in the read allowlist or Node cannot load
      // the entry module and its sibling imports (confirmed by spike).
      // Repeated --allow-fs-read flags (not comma-separated) — Node 20.20+
      // deprecated the comma form; repeated flags are the stable interface.
      nodeArgs.push('--experimental-permission');
      nodeArgs.push(
        ...fsFlags('--allow-fs-read', [skill.dir, tmp], permissions.fs.read),
      );
      nodeArgs.push(
        ...fsFlags('--allow-fs-write', [tmp], permissions.fs.write),
      );
      if (permissions.exec) {
        nodeArgs.push('--allow-child-process');
      }
      // net is declared-only in Phase 1 — not enforced in the runner yet.
    }

    return new Promise((resolve) => {
      const child = spawn(process.execPath, [...nodeArgs, skill.entry], {
        cwd: skill.dir,
        env,
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
