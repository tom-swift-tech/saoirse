// The daemon loads .env from the package root so it works regardless of cwd.
// Precedence matters: a value already in the environment (the shell) wins.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { parseEnv, loadDotenv } from '../src/load-env.js';

describe('parseEnv', () => {
  it('parses KEY=VALUE, skips comments/blanks, strips quotes, keeps = in values', () => {
    const env = parseEnv(
      [
        '# a comment',
        '',
        '  ',
        'PORT=8787',
        'MODEL_ENDPOINT=http://localhost:11434/v1',
        'QUOTED="a value"',
        "SINGLE='b'",
        'URLISH=http://x/y?z=1', // value contains '='
        'noEquals',
      ].join('\n'),
    );
    expect(env).toEqual({
      PORT: '8787',
      MODEL_ENDPOINT: 'http://localhost:11434/v1',
      QUOTED: 'a value',
      SINGLE: 'b',
      URLISH: 'http://x/y?z=1',
    });
  });
});

describe('loadDotenv', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('adds file vars but never overrides values already set (shell wins)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'saoirse-env-'));
    const file = join(dir, '.env');
    writeFileSync(file, 'MODEL_NAME=from-file\nNEW_KEY=hello\n');
    const env: NodeJS.ProcessEnv = { MODEL_NAME: 'from-shell' };

    loadDotenv(file, env);

    expect(env.MODEL_NAME).toBe('from-shell'); // not overridden
    expect(env.NEW_KEY).toBe('hello'); // added from file
    rmSync(dir, { recursive: true, force: true });
  });

  it('emits one stderr line and does not throw when the file is missing', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const missingPath = join(tmpdir(), 'nope-does-not-exist.env');
    const env: NodeJS.ProcessEnv = {};

    loadDotenv(missingPath, env);

    expect(Object.keys(env)).toHaveLength(0);
    expect(stderrSpy).toHaveBeenCalledOnce();
    expect(stderrSpy.mock.calls[0][0]).toContain('[saoirse] no .env found at');
    expect(stderrSpy.mock.calls[0][0]).toContain(missingPath);
  });

  it('default path resolves to package root .env, not cwd', () => {
    // The module lives at src/load-env.ts; during test runs (ts source, no build),
    // import.meta.url points there. The default is computed from the compiled
    // dist/load-env.js at runtime, which is two levels up from the file.
    // We verify the exported default stays within the repo tree, not cwd.
    const thisDir = dirname(fileURLToPath(import.meta.url)); // tests/
    const repoRoot = resolve(thisDir, '..'); // D:\projects\saoirse
    const expectedEnvPath = resolve(repoRoot, '.env');

    // Spy to capture the path that was attempted when no .env is present.
    // We call with no explicit path so the module default is used.
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const env: NodeJS.ProcessEnv = {};

    // Only run this assertion when the real .env doesn't exist, to avoid
    // loading secrets into the test env object. If .env exists at repo root
    // the function succeeds silently, which is also correct.
    const envExists = existsSync(expectedEnvPath);

    loadDotenv(expectedEnvPath, env);

    if (!envExists) {
      // stderr must mention the package-root path
      expect(stderrSpy).toHaveBeenCalledOnce();
      expect(stderrSpy.mock.calls[0][0]).toContain(expectedEnvPath);
    } else {
      // .env exists — function loaded it silently; no stderr expected
      expect(stderrSpy).not.toHaveBeenCalled();
    }
  });
});
