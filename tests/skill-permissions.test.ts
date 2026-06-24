// =============================================================================
// skill-permissions.test.ts — unit coverage for parsePermissions and hasGrants.
//
// parsePermissions is pure validation: undefined → DENY_ALL, valid object →
// normalised SkillPermissions, anything malformed → throw. hasGrants is a
// simple predicate over the grant. Both are exercised exhaustively here so
// skills.test.ts can focus on the loader integration path.
// =============================================================================
import { describe, it, expect } from 'vitest';
import {
  parsePermissions,
  hasGrants,
  DENY_ALL_PERMISSIONS,
} from '../src/core/skill-permissions.js';

// ---------------------------------------------------------------------------
// parsePermissions — undefined / null ⇒ DENY_ALL
// ---------------------------------------------------------------------------
describe('parsePermissions — absent value', () => {
  it('returns DENY_ALL for undefined', () => {
    expect(parsePermissions(undefined)).toEqual(DENY_ALL_PERMISSIONS);
  });

  it('returns DENY_ALL for null', () => {
    expect(parsePermissions(null)).toEqual(DENY_ALL_PERMISSIONS);
  });

  it('returns a fresh object each call (not the frozen singleton)', () => {
    const a = parsePermissions(undefined);
    const b = parsePermissions(undefined);
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// parsePermissions — full valid block normalises correctly
// ---------------------------------------------------------------------------
describe('parsePermissions — valid block', () => {
  it('round-trips a full permissions block', () => {
    const raw = {
      secrets: ['GITHUB_TOKEN', 'NPM_TOKEN'],
      env: ['CI', 'DEBUG'],
      net: ['api.github.com', 'registry.npmjs.org'],
      fs: { read: ['/data/input'], write: ['/tmp/out'] },
      exec: true,
    };
    const p = parsePermissions(raw);
    expect(p.secrets).toEqual(['GITHUB_TOKEN', 'NPM_TOKEN']);
    expect(p.env).toEqual(['CI', 'DEBUG']);
    expect(p.net).toEqual(['api.github.com', 'registry.npmjs.org']);
    expect(p.fs.read).toEqual(['/data/input']);
    expect(p.fs.write).toEqual(['/tmp/out']);
    expect(p.exec).toBe(true);
  });

  it('defaults omitted arrays to [] and exec to false', () => {
    const p = parsePermissions({});
    expect(p).toEqual(DENY_ALL_PERMISSIONS);
  });

  it('accepts a partial permissions object', () => {
    const p = parsePermissions({ secrets: ['MY_SECRET'], exec: false });
    expect(p.secrets).toEqual(['MY_SECRET']);
    expect(p.env).toEqual([]);
    expect(p.exec).toBe(false);
  });

  it('trims whitespace from string array entries', () => {
    const p = parsePermissions({ secrets: ['  TOKEN  '] });
    expect(p.secrets).toEqual(['TOKEN']);
  });

  it('accepts an empty fs block', () => {
    const p = parsePermissions({ fs: {} });
    expect(p.fs.read).toEqual([]);
    expect(p.fs.write).toEqual([]);
  });

  it('accepts a read-only fs block', () => {
    const p = parsePermissions({ fs: { read: ['/mnt/data'] } });
    expect(p.fs.read).toEqual(['/mnt/data']);
    expect(p.fs.write).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// parsePermissions — malformed cases must throw
// ---------------------------------------------------------------------------
describe('parsePermissions — malformed inputs throw', () => {
  it('throws when permissions is not an object', () => {
    expect(() => parsePermissions('bad')).toThrow(/"permissions" must be an object/);
  });

  it('throws when permissions is an array', () => {
    expect(() => parsePermissions(['secrets'])).toThrow(/"permissions" must be an object/);
  });

  it('throws on an unknown top-level key', () => {
    expect(() => parsePermissions({ unknown: true })).toThrow(/unknown permission/);
  });

  it('throws on unknown fs scope key', () => {
    expect(() => parsePermissions({ fs: { execute: ['/bin'] } })).toThrow(
      /unknown fs scope/,
    );
  });

  it('throws when a string-array field is not an array', () => {
    expect(() => parsePermissions({ secrets: 'TOKEN' })).toThrow(
      /"permissions.secrets" must be an array/,
    );
  });

  it('throws when a string-array entry is not a string', () => {
    expect(() => parsePermissions({ env: [42] })).toThrow(
      /"permissions.env" must be an array/,
    );
  });

  it('throws when a string-array entry is an empty string', () => {
    expect(() => parsePermissions({ net: [''] })).toThrow(
      /"permissions.net" must be an array/,
    );
  });

  it('throws when exec is not a boolean', () => {
    expect(() => parsePermissions({ exec: 'yes' })).toThrow(
      /"permissions.exec" must be a boolean/,
    );
  });

  it('throws when fs is not an object', () => {
    expect(() => parsePermissions({ fs: ['/data'] })).toThrow(
      /"permissions.fs" must be an object/,
    );
  });

  it('throws when fs.read contains a non-string entry', () => {
    expect(() => parsePermissions({ fs: { read: [99] } })).toThrow(
      /"permissions.fs.read" must be an array/,
    );
  });

  it('throws when fs.write contains an empty string', () => {
    expect(() => parsePermissions({ fs: { write: [''] } })).toThrow(
      /"permissions.fs.write" must be an array/,
    );
  });
});

// ---------------------------------------------------------------------------
// hasGrants
// ---------------------------------------------------------------------------
describe('hasGrants', () => {
  it('returns false for DENY_ALL', () => {
    expect(hasGrants(DENY_ALL_PERMISSIONS)).toBe(false);
  });

  it('returns false for a freshly parsed empty block', () => {
    expect(hasGrants(parsePermissions({}))).toBe(false);
  });

  it('returns true when secrets is non-empty', () => {
    expect(hasGrants(parsePermissions({ secrets: ['TOKEN'] }))).toBe(true);
  });

  it('returns true when env is non-empty', () => {
    expect(hasGrants(parsePermissions({ env: ['CI'] }))).toBe(true);
  });

  it('returns true when net is non-empty', () => {
    expect(hasGrants(parsePermissions({ net: ['example.com'] }))).toBe(true);
  });

  it('returns true when fs.read is non-empty', () => {
    expect(hasGrants(parsePermissions({ fs: { read: ['/data'] } }))).toBe(true);
  });

  it('returns true when fs.write is non-empty', () => {
    expect(hasGrants(parsePermissions({ fs: { write: ['/out'] } }))).toBe(true);
  });

  it('returns true when exec is true', () => {
    expect(hasGrants(parsePermissions({ exec: true }))).toBe(true);
  });
});
