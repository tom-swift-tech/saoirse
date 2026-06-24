// =============================================================================
// load-env.ts — minimal .env loader (zero dependencies).
//
// The daemon reads its config from process.env. This loads a local .env file
// into process.env at startup so `cp .env.example .env` works as documented.
// Semantics mirror dotenv: KEY=VALUE per line, `#` comments, optional quotes,
// and a variable already set in the environment WINS (the shell overrides the
// file). A missing .env is a no-op, not an error (but it is loud on stderr so
// a misconfigured daemon is visible immediately).
//
// Default path resolution: at runtime this module lives at dist/load-env.js,
// so the package root is two levels up from the module file. We derive that
// from import.meta.url so the default is correct regardless of cwd.
// =============================================================================

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Package root = dirname(dist/load-env.js) / .. / .. = <repo root>
const _pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const _defaultEnvPath = resolve(_pkgRoot, '.env');

export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!key) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** Load `.env` (default: package root, not cwd) into env, never overriding values already set. */
export function loadDotenv(
  path: string = _defaultEnvPath,
  env: NodeJS.ProcessEnv = process.env,
): void {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    // Loud so a misconfigured daemon is immediately visible in logs.
    process.stderr.write(`[saoirse] no .env found at ${path} — using shell env / defaults\n`);
    return;
  }
  for (const [key, value] of Object.entries(parseEnv(text))) {
    if (env[key] === undefined) env[key] = value;
  }
}
