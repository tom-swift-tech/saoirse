// =============================================================================
// tool-builder.ts — The Tool-Builder seam (Tier 1).
//
// Saoirse can build tools she needs on the fly. This is the highest-blast-radius
// capability in the system, so the seam is shaped by the governance gate, not
// just the power: a builder produces an ACCRETED artifact in a SANDBOX and
// reports what it made. It has no path to the live `skills/` — promotion is a
// separate, human-gated action (see proposals.ts approveProposal).
//
// Mirrors the ModelGateway pattern: an interface the core depends on, with a
// configured concrete impl (pi). pi is a tool Saoirse USES via this seam, never
// imported into core logic.
// =============================================================================

export interface ToolSpec {
  /** Tool name — becomes the skills/<name> directory once promoted. */
  name: string;
  /** What the tool should do — handed to the builder. */
  description: string;
  /** Optional test command the builder should run in the sandbox. */
  test?: string;
}

export interface BuildResult {
  /** Whether the build (and any spec tests) succeeded. */
  ok: boolean;
  /** Stable id; also the sandbox sub-directory name. */
  id: string;
  /** Sanitised tool name (safe single path segment). */
  toolName: string;
  /** Absolute sandbox directory the artifact was written into (inside PI_SANDBOX). */
  sandboxDir: string;
  /** File paths written, relative to sandboxDir. */
  files: string[];
  /** Human-readable diff of what was created. */
  diff: string;
  /** Output of the spec's tests (or a note that none ran). */
  testOutput: string;
  /** Why the builder thinks this satisfies the spec. */
  rationale: string;
  /** Populated when ok === false. */
  error?: string;
}

export interface ToolBuilder {
  build(spec: ToolSpec): Promise<BuildResult>;
}

/** Reduce an arbitrary tool name to one safe path segment (no separators, no dots-only). */
export function safeToolName(name: string): string {
  const cleaned = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .replace(/-+/g, '-');
  if (!cleaned || cleaned === '.' || cleaned === '..') {
    throw new Error(`invalid tool name: "${name}"`);
  }
  return cleaned;
}
