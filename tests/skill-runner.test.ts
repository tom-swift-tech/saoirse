// The skill runner: one short-lived subprocess per call — args as JSON on
// stdin, stdout is the tool result. Crashes and hangs fail VISIBLY and are
// scoped to the one call (the outcome reports them; nothing throws).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProcessSkillRunner } from '../src/core/skill-runner.js';
import type { LoadedSkill } from '../src/core/skills.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'saoirse-runner-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function makeSkill(
  source: string,
  overrides: Partial<LoadedSkill> = {},
): Promise<LoadedSkill> {
  const entry = join(dir, 'run.mjs');
  await writeFile(entry, source, 'utf8');
  return {
    name: 'test-skill',
    description: 'a test skill',
    parameters: { type: 'object', properties: {} },
    dir,
    entry,
    ...overrides,
  };
}

// Echo the parsed stdin back — proves args travel in and the result travels out.
const ECHO = `
let raw = '';
process.stdin.on('data', (d) => (raw += d));
process.stdin.on('end', () => {
  const args = JSON.parse(raw || '{}');
  process.stdout.write(JSON.stringify({ echoed: args.city }));
});
`;

describe('ProcessSkillRunner', () => {
  it('passes JSON args on stdin and returns stdout as the result', async () => {
    const skill = await makeSkill(ECHO);
    const outcome = await new ProcessSkillRunner().run(
      skill,
      JSON.stringify({ city: 'Galway' }),
    );
    expect(outcome.ok).toBe(true);
    expect(JSON.parse(outcome.output)).toEqual({ echoed: 'Galway' });
  });

  it('reports a non-zero exit with stderr, without throwing', async () => {
    const skill = await makeSkill(
      'console.error("boom: no such city"); process.exit(2);',
    );
    const outcome = await new ProcessSkillRunner().run(skill, '{}');
    expect(outcome.ok).toBe(false);
    expect(outcome.output).toMatch(/exited 2/);
    expect(outcome.output).toMatch(/boom: no such city/);
  });

  it('kills a hung skill at its timeout and says so', async () => {
    const skill = await makeSkill('setTimeout(() => {}, 60_000);', {
      timeoutMs: 300,
    });
    const outcome = await new ProcessSkillRunner().run(skill, '{}');
    expect(outcome.ok).toBe(false);
    expect(outcome.output).toMatch(/timed out after 300ms/);
  });

  it('per-skill timeout overrides the runner default', async () => {
    const skill = await makeSkill(ECHO, { timeoutMs: 5_000 });
    const runner = new ProcessSkillRunner({ timeoutMs: 1 });
    const outcome = await runner.run(skill, '{}');
    expect(outcome.ok).toBe(true);
  });

  // Report what the subprocess actually sees: the daemon's secret and PATH.
  const ENV_PROBE = `
process.stdout.write(JSON.stringify({
  token: process.env.SAOIRSE_TOKEN ?? null,
  secret: process.env.SAOIRSE_TEST_SECRET ?? null,
  hasPath: typeof (process.env.PATH ?? process.env.Path) === 'string',
}));
`;

  it('does not leak the daemon env into the skill; the safe baseline still flows', async () => {
    const before = process.env.SAOIRSE_TOKEN;
    process.env.SAOIRSE_TOKEN = 'daemon-secret-do-not-leak';
    try {
      const skill = await makeSkill(ENV_PROBE);
      const outcome = await new ProcessSkillRunner().run(skill, '{}');
      expect(outcome.ok).toBe(true);
      const seen = JSON.parse(outcome.output);
      expect(seen.token).toBeNull(); // the secret stopped at the allowlist
      expect(seen.hasPath).toBe(true); // …but the skill can still find binaries
    } finally {
      if (before === undefined) delete process.env.SAOIRSE_TOKEN;
      else process.env.SAOIRSE_TOKEN = before;
    }
  });

  it('a key named in allowEnv is deliberately granted through', async () => {
    const before = process.env.SAOIRSE_TEST_SECRET;
    process.env.SAOIRSE_TEST_SECRET = 'granted-on-purpose';
    try {
      const skill = await makeSkill(ENV_PROBE);
      const runner = new ProcessSkillRunner({
        allowEnv: ['SAOIRSE_TEST_SECRET'],
      });
      const outcome = await runner.run(skill, '{}');
      expect(outcome.ok).toBe(true);
      expect(JSON.parse(outcome.output).secret).toBe('granted-on-purpose');
    } finally {
      if (before === undefined) delete process.env.SAOIRSE_TEST_SECRET;
      else process.env.SAOIRSE_TEST_SECRET = before;
    }
  });
});
