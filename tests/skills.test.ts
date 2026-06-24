// The committed-skill loader: valid manifests load; every invalid shape fails
// VISIBLY (reported in errors) and is skipped — scoped to that one capability,
// never fatal (SYSTEM.md Tier 1).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadSkills,
  toToolDefinition,
  validateSkillDir,
} from '../src/core/skills.js';
import { DENY_ALL_PERMISSIONS } from '../src/core/skill-permissions.js';

let skillsDir: string;

beforeEach(async () => {
  skillsDir = await mkdtemp(join(tmpdir(), 'saoirse-skills-'));
});

afterEach(async () => {
  await rm(skillsDir, { recursive: true, force: true });
});

async function writeSkill(
  name: string,
  manifest: unknown,
  files: Record<string, string> = { 'run.mjs': 'process.stdout.write("{}")' },
): Promise<string> {
  const dir = join(skillsDir, name);
  await mkdir(dir, { recursive: true });
  if (manifest !== undefined) {
    await writeFile(join(dir, 'skill.json'), JSON.stringify(manifest), 'utf8');
  }
  for (const [rel, content] of Object.entries(files)) {
    await writeFile(join(dir, rel), content, 'utf8');
  }
  return dir;
}

const VALID = {
  name: 'clock',
  description: 'tell the current time',
  entry: 'run.mjs',
  parameters: { type: 'object', properties: { tz: { type: 'string' } } },
};

describe('loadSkills', () => {
  it('loads a valid skill with its manifest fields', async () => {
    await writeSkill('clock', VALID);
    const report = await loadSkills(skillsDir);
    expect(report.errors).toEqual([]);
    expect(report.skills).toHaveLength(1);
    const [skill] = report.skills;
    expect(skill.name).toBe('clock');
    expect(skill.entry).toBe(join(skillsDir, 'clock', 'run.mjs'));
    expect(skill.parameters).toEqual(VALID.parameters);
  });

  it('defaults parameters to an empty object schema', async () => {
    await writeSkill('clock', { ...VALID, parameters: undefined });
    const { skills } = await loadSkills(skillsDir);
    expect(skills[0].parameters).toEqual({ type: 'object', properties: {} });
  });

  it('returns zero skills for a missing skills directory', async () => {
    const report = await loadSkills(join(skillsDir, 'does-not-exist'));
    expect(report).toEqual({ skills: [], errors: [] });
  });

  it.each([
    ['missing manifest', undefined, /missing skill\.json/],
    [
      'name/dir mismatch',
      { ...VALID, name: 'other' },
      /must match the directory/,
    ],
    ['empty description', { ...VALID, description: ' ' }, /"description"/],
    ['missing entry', { ...VALID, entry: 'nope.mjs' }, /does not exist/],
    [
      'entry escaping the dir',
      { ...VALID, entry: '../outside.mjs' },
      /escapes/,
    ],
    [
      'non-object parameters',
      { ...VALID, parameters: [1] },
      /JSON Schema object/,
    ],
  ])('skips and reports: %s', async (_label, manifest, reason) => {
    await writeSkill('clock', manifest);
    const report = await loadSkills(skillsDir);
    expect(report.skills).toEqual([]);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]).toMatch(reason);
  });

  it('a broken skill never blocks a valid sibling', async () => {
    await writeSkill('bad', undefined);
    await writeSkill('clock', VALID);
    const report = await loadSkills(skillsDir);
    expect(report.skills.map((s) => s.name)).toEqual(['clock']);
    expect(report.errors).toHaveLength(1);
  });

  it('reports invalid JSON as such', async () => {
    const dir = join(skillsDir, 'clock');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'skill.json'), '{not json', 'utf8');
    const report = await loadSkills(skillsDir);
    expect(report.errors[0]).toMatch(/not valid JSON/);
  });
});

describe('toToolDefinition', () => {
  it('maps a loaded skill onto the OpenAI tool shape', async () => {
    await writeSkill('clock', VALID);
    const { skills } = await loadSkills(skillsDir);
    expect(toToolDefinition(skills[0])).toEqual({
      name: 'clock',
      description: 'tell the current time',
      parameters: VALID.parameters,
    });
  });
});

describe('loadSkills — permissions field', () => {
  it('carries a parsed grant when the manifest has a valid permissions block', async () => {
    const manifest = {
      ...VALID,
      permissions: {
        secrets: ['GITHUB_TOKEN'],
        env: ['CI'],
        net: ['api.github.com'],
        fs: { read: ['/data'], write: ['/tmp/out'] },
        exec: true,
      },
    };
    await writeSkill('clock', manifest);
    const { skills, errors } = await loadSkills(skillsDir);
    expect(errors).toEqual([]);
    expect(skills).toHaveLength(1);
    const { permissions } = skills[0];
    expect(permissions.secrets).toEqual(['GITHUB_TOKEN']);
    expect(permissions.env).toEqual(['CI']);
    expect(permissions.net).toEqual(['api.github.com']);
    expect(permissions.fs.read).toEqual(['/data']);
    expect(permissions.fs.write).toEqual(['/tmp/out']);
    expect(permissions.exec).toBe(true);
  });

  it('carries DENY_ALL when the manifest has no permissions block', async () => {
    await writeSkill('clock', VALID);
    const { skills, errors } = await loadSkills(skillsDir);
    expect(errors).toEqual([]);
    const { permissions } = skills[0];
    expect(permissions).toEqual(DENY_ALL_PERMISSIONS);
  });

  it.each([
    ['secrets not an array', { permissions: { secrets: 'bad' } }],
    ['exec not a boolean', { permissions: { exec: 'yes' } }],
    ['unknown top-level permission key', { permissions: { unknown: true } }],
  ])('skips and reports malformed permissions: %s', async (_label, extra) => {
    await writeSkill('clock', { ...VALID, ...extra });
    const { skills, errors } = await loadSkills(skillsDir);
    expect(skills).toEqual([]);
    expect(errors).toHaveLength(1);
  });
});

describe('validateSkillDir (promotion-time advisory)', () => {
  it('returns undefined for a loadable skill', async () => {
    const dir = await writeSkill('clock', VALID);
    expect(await validateSkillDir(dir, 'clock')).toBeUndefined();
  });

  it('returns the reason for an unloadable one', async () => {
    const dir = await writeSkill('clock', undefined);
    expect(await validateSkillDir(dir, 'clock')).toMatch(/missing skill\.json/);
  });
});
