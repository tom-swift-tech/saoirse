// =============================================================================
// sandbox.ts — Path containment guard.
//
// The Tool-Builder (pi) writes ONLY inside its sandbox. This resolves a path
// against a root and throws if the result escapes that root (via "..", an
// absolute path, a symlink-ish prefix trick, etc.). Used wherever a
// caller-supplied path is joined to a trusted directory — the structural reason
// a built tool cannot write into the live daemon's directories.
// =============================================================================

import { resolve, sep } from 'node:path';

export function resolveInside(root: string, relPath: string): string {
  const absRoot = resolve(root);
  const target = resolve(absRoot, relPath);
  if (target !== absRoot && !target.startsWith(absRoot + sep)) {
    throw new Error(
      `path "${relPath}" escapes the permitted root "${absRoot}"`,
    );
  }
  return target;
}

/** True if `target` is the root itself or nested within it. */
export function isInside(root: string, target: string): boolean {
  const absRoot = resolve(root);
  const absTarget = resolve(target);
  return absTarget === absRoot || absTarget.startsWith(absRoot + sep);
}
