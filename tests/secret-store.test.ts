// captureSecretStore: reads SAOIRSE_SECRET_* from the env object, captures the
// bare names into a private store, and SCRUBS those keys from the passed env so
// they never appear in a subprocess's inherited environment.
import { describe, it, expect } from 'vitest';
import { captureSecretStore, SECRET_ENV_PREFIX } from '../src/core/secret-store.js';

describe('captureSecretStore', () => {
  it('captures SAOIRSE_SECRET_* keys under the bare name', () => {
    const env: NodeJS.ProcessEnv = {
      SAOIRSE_SECRET_GMAIL_PW: 'hunter2',
      SAOIRSE_SECRET_GITHUB_TOKEN: 'ghp_abc123',
    };
    const store = captureSecretStore(env);
    expect(store.get('GMAIL_PW')).toBe('hunter2');
    expect(store.get('GITHUB_TOKEN')).toBe('ghp_abc123');
  });

  it('scrubs SAOIRSE_SECRET_* from the passed env object after capture', () => {
    const env: NodeJS.ProcessEnv = {
      SAOIRSE_SECRET_API_KEY: 'secret-value',
      PATH: '/usr/bin',
    };
    captureSecretStore(env);
    // The prefixed key must be gone — it must not appear in any child env.
    expect('SAOIRSE_SECRET_API_KEY' in env).toBe(false);
    expect(env.SAOIRSE_SECRET_API_KEY).toBeUndefined();
    // Non-secret keys are untouched.
    expect(env.PATH).toBe('/usr/bin');
  });

  it('has() returns true for held names and false for unknown ones', () => {
    const env: NodeJS.ProcessEnv = { SAOIRSE_SECRET_TOKEN: 'tok' };
    const store = captureSecretStore(env);
    expect(store.has('TOKEN')).toBe(true);
    expect(store.has('SAOIRSE_SECRET_TOKEN')).toBe(false); // the bare name, not the full key
    expect(store.has('NONEXISTENT')).toBe(false);
  });

  it('names() returns held names sorted alphabetically', () => {
    const env: NodeJS.ProcessEnv = {
      SAOIRSE_SECRET_ZEBRA: 'z',
      SAOIRSE_SECRET_ALPHA: 'a',
      SAOIRSE_SECRET_MIDDLE: 'm',
    };
    const store = captureSecretStore(env);
    expect(store.names()).toEqual(['ALPHA', 'MIDDLE', 'ZEBRA']);
  });

  it('returns an empty store when no matching keys are present', () => {
    const env: NodeJS.ProcessEnv = { PATH: '/bin', HOME: '/home/user' };
    const store = captureSecretStore(env);
    expect(store.names()).toEqual([]);
    expect(store.has('anything')).toBe(false);
    expect(store.get('anything')).toBeUndefined();
  });

  it('does not touch keys that merely contain the prefix but are not prefixed', () => {
    // e.g. FOO_SAOIRSE_SECRET_BAR must be left alone.
    const env: NodeJS.ProcessEnv = {
      FOO_SAOIRSE_SECRET_BAR: 'bystander',
      SAOIRSE_SECRET_: 'malformed-no-name', // exactly the prefix, no name suffix
    };
    captureSecretStore(env);
    // The bystander must survive.
    expect(env.FOO_SAOIRSE_SECRET_BAR).toBe('bystander');
    // The bare-prefix key (no name) is also left alone (length === prefix.length guard).
    expect(env.SAOIRSE_SECRET_).toBe('malformed-no-name');
  });

  it('get() returns undefined for a name not in the store', () => {
    const env: NodeJS.ProcessEnv = { SAOIRSE_SECRET_REAL: 'here' };
    const store = captureSecretStore(env);
    expect(store.get('IMAGINARY')).toBeUndefined();
  });

  it('respects a custom prefix override', () => {
    const env: NodeJS.ProcessEnv = {
      MY_PREFIX_FOO: 'foo-val',
      SAOIRSE_SECRET_BAR: 'bar-val', // default prefix — should NOT be captured
    };
    const store = captureSecretStore(env, 'MY_PREFIX_');
    expect(store.get('FOO')).toBe('foo-val');
    expect(store.get('BAR')).toBeUndefined();
    // MY_PREFIX_FOO is scrubbed; SAOIRSE_SECRET_BAR is untouched.
    expect('MY_PREFIX_FOO' in env).toBe(false);
    expect(env.SAOIRSE_SECRET_BAR).toBe('bar-val');
  });

  it('the SECRET_ENV_PREFIX export matches the default used by captureSecretStore', () => {
    // This pins the public constant to the real default so callers that construct
    // full key names (e.g. .env documentation generators) don't drift from the impl.
    const env: NodeJS.ProcessEnv = {};
    env[`${SECRET_ENV_PREFIX}SENTINEL`] = 'sentinel-val';
    const store = captureSecretStore(env);
    expect(store.get('SENTINEL')).toBe('sentinel-val');
  });
});
