// =============================================================================
// secret-store.ts — the env-prefix secret store (Primitive 1, Phase 1).
//
// Decision (docs/design/skill-permissions.md): secrets live as SAOIRSE_SECRET_*
// env vars (read from .env). At boot they are captured into a private in-memory
// map and SCRUBBED from process.env, so the live daemon process env never holds
// them (no /proc/<pid>/environ or crash-dump leak) and nothing inherits them by
// accident. A skill that declares `secrets: ["GMAIL_PW"]` gets the bare GMAIL_PW
// injected into ITS subprocess only — never any secret it did not declare.
// =============================================================================

export const SECRET_ENV_PREFIX = 'SAOIRSE_SECRET_';

export interface SecretStore {
  /** The secret value for a logical name, or undefined if not held. */
  get(name: string): string | undefined;
  has(name: string): boolean;
  /** Logical names held — for the /status audit (NAMES only, never values). */
  names(): string[];
}

/**
 * Capture every SAOIRSE_SECRET_<NAME> from `env` into a private store and DELETE
 * those keys from `env` (the scrub). Returns the store. Call ONCE at boot, after
 * loadDotenv() and before anything can spawn a skill.
 *
 * `<NAME>` is the key after the prefix (e.g. SAOIRSE_SECRET_GMAIL_PW → GMAIL_PW).
 */
export function captureSecretStore(
  env: NodeJS.ProcessEnv = process.env,
  prefix: string = SECRET_ENV_PREFIX,
): SecretStore {
  const secrets = new Map<string, string>();
  for (const key of Object.keys(env)) {
    if (!key.startsWith(prefix) || key.length === prefix.length) continue;
    const name = key.slice(prefix.length);
    const value = env[key];
    if (typeof value === 'string') secrets.set(name, value);
    delete env[key]; // scrub from the live process env
  }

  return {
    get: (name) => secrets.get(name),
    has: (name) => secrets.has(name),
    names: () => [...secrets.keys()].sort(),
  };
}
