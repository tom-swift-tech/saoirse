// =============================================================================
// skill-permissions.ts — the permission grant a skill declares in its manifest.
//
// Primitive 1 (docs/design/skill-permissions.md). A skill that needs to reach
// anything beyond a fresh shell — a credential, a filesystem path, the ability
// to spawn — declares it here. The declaration is DEFAULT-DENY (absent ⇒ the
// deny-all baseline) and the grant IS the approval: a `permissions` block rides
// inside the proposal diff a human approves at promotion, so privilege
// escalation is visible at the gate, never silent.
//
// This module is pure validation + types. Enforcement lives in the runner
// (skill-runner.ts): secrets/env injected into the subprocess env, fs/exec
// enforced via Node's permission model. `net` is DECLARED-ONLY in Phase 1
// (shown for review; egress enforcement is Phase 2 — generalize the webfetch
// SSRF guard).
// =============================================================================

export interface SkillPermissions {
  /** Logical secret names — injected from SAOIRSE_SECRET_<NAME> into the skill env. */
  secrets: string[];
  /** Non-secret env keys passed through beyond the safe baseline. */
  env: string[];
  /** Egress host allowlist. DECLARED ONLY in Phase 1 (reviewed, not yet enforced). */
  net: string[];
  /** Filesystem scopes granted beyond the skill's own dir + temp. */
  fs: { read: string[]; write: string[] };
  /** May the skill spawn child processes? */
  exec: boolean;
}

/** The default-deny baseline: a skill that declares no `permissions` block. */
export const DENY_ALL_PERMISSIONS: SkillPermissions = Object.freeze({
  secrets: [],
  env: [],
  net: [],
  fs: Object.freeze({ read: [], write: [] }) as { read: string[]; write: string[] },
  exec: false,
});

/** True if the grant requests anything beyond the deny-all baseline. */
export function hasGrants(p: SkillPermissions): boolean {
  return (
    p.secrets.length > 0 ||
    p.env.length > 0 ||
    p.net.length > 0 ||
    p.fs.read.length > 0 ||
    p.fs.write.length > 0 ||
    p.exec
  );
}

/**
 * Validate + normalize a raw manifest `permissions` value into SkillPermissions.
 * Throws on a malformed grant — the skill is then skipped and reported, exactly
 * like any other bad-manifest field. `undefined`/`null` ⇒ a fresh DENY_ALL copy
 * (default-deny, backward compatible with every existing skill).
 */
export function parsePermissions(raw: unknown): SkillPermissions {
  if (raw === undefined || raw === null) return freshDenyAll();
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('"permissions" must be an object');
  }
  const r = raw as Record<string, unknown>;

  const KNOWN = new Set(['secrets', 'env', 'net', 'fs', 'exec']);
  for (const key of Object.keys(r)) {
    if (!KNOWN.has(key)) throw new Error(`unknown permission "${key}"`);
  }

  let fsRead: string[] = [];
  let fsWrite: string[] = [];
  if (r.fs !== undefined) {
    if (typeof r.fs !== 'object' || r.fs === null || Array.isArray(r.fs)) {
      throw new Error('"permissions.fs" must be an object with read/write arrays');
    }
    const fsRaw = r.fs as Record<string, unknown>;
    for (const key of Object.keys(fsRaw)) {
      if (key !== 'read' && key !== 'write') {
        throw new Error(`unknown fs scope "${key}" (expected read/write)`);
      }
    }
    fsRead = strArray(fsRaw.read, 'fs.read');
    fsWrite = strArray(fsRaw.write, 'fs.write');
  }

  return {
    secrets: strArray(r.secrets, 'secrets'),
    env: strArray(r.env, 'env'),
    net: strArray(r.net, 'net'),
    fs: { read: fsRead, write: fsWrite },
    exec: boolField(r.exec, 'exec'),
  };
}

function strArray(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.some((x) => typeof x !== 'string' || x.trim() === '')
  ) {
    throw new Error(`"permissions.${field}" must be an array of non-empty strings`);
  }
  return value.map((x) => (x as string).trim());
}

function boolField(value: unknown, field: string): boolean {
  if (value === undefined) return false;
  if (typeof value !== 'boolean') {
    throw new Error(`"permissions.${field}" must be a boolean`);
  }
  return value;
}

function freshDenyAll(): SkillPermissions {
  return { secrets: [], env: [], net: [], fs: { read: [], write: [] }, exec: false };
}
