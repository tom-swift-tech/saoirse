// The pi side of the Tool-Builder contract (scripts/pi-build.mjs), tested with
// a FAUX pi binary — never the real agent, never a model. The faux pi writes
// files into its cwd exactly like the real one would, and records the argv/env
// it was invoked with so the tests can assert the adapter's wiring: private
// PI_CODING_AGENT_DIR config pointing at MODEL_ENDPOINT, non-interactive flags,
// and the stdin-spec → stdout-result contract PiToolBuilder consumes.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ADAPTER = join(__dirname, '..', 'scripts', 'pi-build.mjs');

interface AdapterResult {
  ok: boolean;
  files: Array<{ path: string; content: string }>;
  diff?: string;
  testOutput?: string;
  rationale?: string;
  error?: string;
}

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'saoirse-pi-adapter-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/**
 * A faux pi: writes the given files into its cwd (what the real agent's write
 * tool would do), dumps argv + the env the adapter set into root/invocation.json,
 * prints a rationale on stdout.
 */
function fauxPi(opts: {
  files?: Record<string, string>;
  exitCode?: number;
  stdout?: string;
}): string {
  const script = join(root, 'fakepi.cjs');
  writeFileSync(
    script,
    `const fs = require('fs');
const path = require('path');
const files = ${JSON.stringify(opts.files ?? {})};
for (const [p, content] of Object.entries(files)) {
  fs.mkdirSync(path.dirname(path.join(process.cwd(), p)), { recursive: true });
  fs.writeFileSync(path.join(process.cwd(), p), content);
}
// Captured now — the adapter removes its scratch (config included) on exit.
const modelsJson = fs.readFileSync(path.join(process.env.PI_CODING_AGENT_DIR, 'models.json'), 'utf8');
fs.writeFileSync(${JSON.stringify(join(root, 'invocation.json'))}, JSON.stringify({
  argv: process.argv.slice(2),
  agentDir: process.env.PI_CODING_AGENT_DIR,
  offline: process.env.PI_OFFLINE,
  cwd: process.cwd(),
  modelsJson,
}));
process.stdout.write(${JSON.stringify(opts.stdout ?? 'built it: satisfies the spec')});
process.exit(${opts.exitCode ?? 0});`,
  );
  return `node ${script}`;
}

/** Run the adapter exactly as PiToolBuilder does: spec on stdin, JSON on stdout. */
function runAdapter(
  spec: object,
  env: Record<string, string>,
): Promise<{ code: number | null; result: AdapterResult }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ADAPTER], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => {
      try {
        resolve({ code, result: JSON.parse(stdout) as AdapterResult });
      } catch {
        reject(new Error(`adapter emitted no JSON (exit ${code}): ${stdout} ${stderr}`));
      }
    });
    child.stdin.write(JSON.stringify(spec));
    child.stdin.end();
  });
}

const GOOD_FILES = {
  'skill.json': JSON.stringify({
    name: 'weather',
    description: 'fetch the weather',
    entry: 'run.mjs',
    parameters: { type: 'object', properties: {} },
  }),
  'run.mjs': 'process.stdout.write(JSON.stringify({ok:true}));',
};

describe('pi-build adapter (faux pi, never the real agent)', () => {
  it('happy path: ships the built skill back over the contract', async () => {
    const { code, result } = await runAdapter(
      { name: 'weather', description: 'fetch the weather' },
      { PI_BIN: fauxPi({ files: GOOD_FILES }), MODEL_ENDPOINT: 'http://model-host:1234', MODEL_NAME: 'test-model' },
    );

    expect(code).toBe(0);
    expect(result.ok).toBe(true);
    expect(result.files.map((f) => f.path).sort()).toEqual(['run.mjs', 'skill.json']);
    expect(result.rationale).toContain('satisfies the spec');
    expect(result.diff).toContain('+ skill.json');
    expect(result.testOutput).toBe('(no tests run)');
  });

  it('points pi at MODEL_ENDPOINT via a private agent dir, offline, non-interactive', async () => {
    await runAdapter(
      { name: 'weather', description: 'fetch the weather' },
      { PI_BIN: fauxPi({ files: GOOD_FILES }), MODEL_ENDPOINT: 'http://model-host:1234', MODEL_NAME: 'test-model' },
    );

    const invocation = JSON.parse(readFileSync(join(root, 'invocation.json'), 'utf8'));
    // non-interactive, hermetic flags
    expect(invocation.argv).toContain('-p');
    expect(invocation.argv).toContain('--no-session');
    expect(invocation.argv).toContain('--no-extensions');
    expect(invocation.argv).toContain('--no-context-files');
    expect(invocation.argv).toEqual(expect.arrayContaining(['--provider', 'saoirse', '--model', 'test-model']));
    expect(invocation.offline).toBe('1');
    // the generated models.json declares MODEL_ENDPOINT as the provider
    const models = JSON.parse(invocation.modelsJson);
    expect(models.providers.saoirse.baseUrl).toBe('http://model-host:1234/v1');
    expect(models.providers.saoirse.api).toBe('openai-completions');
    expect(models.providers.saoirse.models[0].id).toBe('test-model');
  });

  it('the brief travels as a file in the work dir and is not shipped as artifact', async () => {
    const { result } = await runAdapter(
      { name: 'weather', description: 'fetch the weather' },
      { PI_BIN: fauxPi({ files: GOOD_FILES }) },
    );
    const invocation = JSON.parse(readFileSync(join(root, 'invocation.json'), 'utf8'));
    expect(invocation.argv).toContain('@PROMPT.saoirse.md');
    expect(result.files.some((f) => f.path.includes('PROMPT'))).toBe(false);
  });

  it('missing skill.json -> ok:false with a precise reason', async () => {
    const { code, result } = await runAdapter(
      { name: 'weather', description: 'fetch the weather' },
      { PI_BIN: fauxPi({ files: { 'run.mjs': 'x' } }) },
    );
    expect(code).toBe(0); // semantic failure, not adapter breakage
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/skill\.json/);
  });

  it('manifest name mismatch -> ok:false', async () => {
    const files = {
      ...GOOD_FILES,
      'skill.json': JSON.stringify({ name: 'other', description: 'x', entry: 'run.mjs' }),
    };
    const { result } = await runAdapter(
      { name: 'weather', description: 'fetch the weather' },
      { PI_BIN: fauxPi({ files }) },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/"name"/);
  });

  it('pi writing nothing -> ok:false', async () => {
    const { result } = await runAdapter(
      { name: 'weather', description: 'fetch the weather' },
      { PI_BIN: fauxPi({}) },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no files/);
  });

  it('pi exiting non-zero -> ok:false carrying pi output', async () => {
    const { code, result } = await runAdapter(
      { name: 'weather', description: 'fetch the weather' },
      { PI_BIN: fauxPi({ exitCode: 3, stdout: 'model endpoint unreachable' }) },
    );
    expect(code).toBe(0);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/pi exited 3/);
  });

  it('runs the spec test in the built skill dir; a failing test fails the build', async () => {
    const pass = await runAdapter(
      { name: 'weather', description: 'w', test: 'node run.mjs' },
      { PI_BIN: fauxPi({ files: GOOD_FILES }) },
    );
    expect(pass.result.ok).toBe(true);
    expect(pass.result.testOutput).toContain('{"ok":true}');

    const failFiles = { ...GOOD_FILES, 'run.mjs': 'process.exit(1);' };
    const fail = await runAdapter(
      { name: 'weather', description: 'w', test: 'node run.mjs' },
      { PI_BIN: fauxPi({ files: failFiles }) },
    );
    expect(fail.result.ok).toBe(false);
    expect(fail.result.error).toMatch(/spec test failed/);
  });

  it('sanitises the tool name into the manifest requirement', async () => {
    const files = {
      ...GOOD_FILES,
      'skill.json': JSON.stringify({
        name: 'my-weather-tool',
        description: 'x',
        entry: 'run.mjs',
      }),
    };
    const { result } = await runAdapter(
      { name: 'My Weather Tool!', description: 'w' },
      { PI_BIN: fauxPi({ files }) },
    );
    expect(result.ok).toBe(true);
  });

  it('end-to-end through PiToolBuilder: adapter output lands containment-checked in the sandbox', async () => {
    const { PiToolBuilder } = await import('../src/core/pi-tool-builder.js');
    const sandboxRoot = join(root, 'sandbox');
    process.env.PI_BIN = fauxPi({ files: GOOD_FILES });
    try {
      const builder = new PiToolBuilder({
        command: `node ${ADAPTER}`,
        sandboxRoot,
      });
      const result = await builder.build({ name: 'weather', description: 'fetch the weather' });
      expect(result.ok).toBe(true);
      expect(existsSync(join(result.sandboxDir, 'skill.json'))).toBe(true);
      expect(existsSync(join(result.sandboxDir, 'run.mjs'))).toBe(true);
    } finally {
      delete process.env.PI_BIN;
    }
  });
});
