// The daemon loads .env from its working dir so `cp .env.example .env` works.
// Precedence matters: a value already in the environment (the shell) wins.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
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

  it('is a no-op when the file is missing', () => {
    const env: NodeJS.ProcessEnv = {};
    loadDotenv(join(tmpdir(), 'nope-does-not-exist.env'), env);
    expect(Object.keys(env)).toHaveLength(0);
  });
});
