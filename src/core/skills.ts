// =============================================================================
// skills.ts — The committed-skill contract and the startup loader.
//
// A skill is a directory inside the live `skills/` tree (written ONLY by the
// token-gated promotion in proposals.ts). To be loadable it must contain a
// `skill.json` manifest:
//
//   {
//     "name":        "weather",            // must equal the directory name
//     "description": "fetch the weather",  // shown to the model
//     "parameters":  { JSON Schema },      // OpenAI tool-call parameters (optional)
//     "entry":       "run.mjs",            // Node script, relative, inside the dir
//     "timeoutMs":   30000,                // optional per-skill run budget
//     "permissions": {                     // optional — absent ⇒ default-deny
//       "secrets": ["GITHUB_TOKEN"],       // logical secret names to inject
//       "env":     ["CI"],                 // non-secret env pass-through
//       "net":     ["api.github.com"],     // egress allowlist (Phase 1: declared, not enforced)
//       "fs":      { "read": ["/data"] },  // fs scopes beyond skill dir + temp
//       "exec":    true                    // may spawn child processes?
//     }
//   }
//
// The loader runs once at daemon start ("loads on next start" — the running
// process is never mutated by a promotion). A bad manifest fails VISIBLY and is
// scoped to that one capability: it is reported and skipped, never fatal
// (SYSTEM.md Tier 1).
// =============================================================================

import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveInside } from './sandbox.js';
import { safeToolName } from './tool-builder.js';
import type { ToolDefinition } from './model-gateway.js';
import { parsePermissions } from './skill-permissions.js';
import type { SkillPermissions } from './skill-permissions.js';

export const MANIFEST_FILENAME = 'skill.json';

/** Default JSON Schema when a manifest declares no parameters. */
const NO_PARAMS = { type: 'object', properties: {} } as const;

export interface LoadedSkill {
  name: string;
  description: string;
  /** JSON Schema for the tool-call arguments. */
  parameters: Record<string, unknown>;
  /** Absolute skill directory (cwd for the run). */
  dir: string;
  /** Absolute entry script path, containment-checked inside `dir`. */
  entry: string;
  /** Per-run budget, ms. */
  timeoutMs?: number;
  /**
   * What the skill is allowed to touch. Always present — DENY_ALL when the
   * manifest declares no `permissions` block (backward-compatible default-deny).
   */
  permissions: SkillPermissions;
}

export interface SkillLoadReport {
  skills: LoadedSkill[];
  /** One human-readable line per directory that failed to load. */
  errors: string[];
}

/**
 * Scan a skills directory and load every valid skill. Never throws for a bad
 * skill — each failure is reported in `errors` and that capability is skipped.
 * A missing skills directory is simply zero skills.
 */
export async function loadSkills(skillsDir: string): Promise<SkillLoadReport> {
  const skills: LoadedSkill[] = [];
  const errors: string[] = [];

  let entries: string[];
  try {
    entries = await readdir(skillsDir);
  } catch {
    return { skills, errors };
  }

  for (const name of entries.sort()) {
    const dir = join(skillsDir, name);
    try {
      if (!(await stat(dir)).isDirectory()) continue;
      skills.push(await loadSkill(dir, name));
    } catch (err) {
      errors.push(`skill "${name}": ${(err as Error).message}`);
    }
  }
  return { skills, errors };
}

/** Load and validate one skill directory. Throws with a precise reason. */
async function loadSkill(dir: string, dirName: string): Promise<LoadedSkill> {
  const manifestPath = join(dir, MANIFEST_FILENAME);
  let raw: string;
  try {
    raw = await readFile(manifestPath, 'utf8');
  } catch {
    throw new Error(`missing ${MANIFEST_FILENAME}`);
  }

  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error(`${MANIFEST_FILENAME} is not valid JSON`);
  }

  const { name, description, entry, parameters, timeoutMs, permissions: rawPermissions } = manifest;
  if (typeof name !== 'string' || safeToolName(name) !== dirName) {
    throw new Error(
      `manifest "name" (${JSON.stringify(name)}) must match the directory name "${dirName}"`,
    );
  }
  if (typeof description !== 'string' || !description.trim()) {
    throw new Error('manifest "description" must be a non-empty string');
  }
  if (typeof entry !== 'string' || !entry.trim()) {
    throw new Error('manifest "entry" must name the entry script');
  }
  // Containment: the entry can never point outside the skill's own directory.
  const entryAbs = resolveInside(dir, entry);
  await stat(entryAbs).catch(() => {
    throw new Error(`entry script "${entry}" does not exist`);
  });
  if (
    parameters !== undefined &&
    (typeof parameters !== 'object' ||
      parameters === null ||
      Array.isArray(parameters))
  ) {
    throw new Error('manifest "parameters" must be a JSON Schema object');
  }

  // Throws on a malformed permissions block — caught by the loadSkills loop and
  // reported there, exactly like any other bad-manifest field.
  const parsedPermissions = parsePermissions(rawPermissions);

  return {
    name,
    description,
    parameters: (parameters as Record<string, unknown> | undefined) ?? {
      ...NO_PARAMS,
    },
    dir,
    entry: entryAbs,
    timeoutMs: typeof timeoutMs === 'number' ? timeoutMs : undefined,
    permissions: parsedPermissions,
  };
}

/** The OpenAI tool definition the model sees for a loaded skill. */
export function toToolDefinition(skill: LoadedSkill): ToolDefinition {
  return {
    name: skill.name,
    description: skill.description,
    parameters: skill.parameters,
  };
}

/**
 * Promotion-time check (advisory): does a directory hold a loadable skill?
 * Returns undefined when valid, else the reason. The gate still promotes — the
 * artifact was human-approved — but the warning is surfaced immediately instead
 * of as a silent no-op at next boot.
 */
export async function validateSkillDir(
  dir: string,
  expectedName: string,
): Promise<string | undefined> {
  try {
    await loadSkill(dir, expectedName);
    return undefined;
  } catch (err) {
    return (err as Error).message;
  }
}
