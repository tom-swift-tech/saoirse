// =============================================================================
// pi-build.mjs — The pi side of the Tool-Builder contract.
//
// PiToolBuilder (src/core/pi-tool-builder.ts) speaks one contract: a JSON
// ToolSpec on stdin, a JSON result { ok, files:[{path,content}], diff,
// testOutput, rationale, error? } on stdout. This adapter implements that
// contract by driving the real pi coding agent (`pi -p`, non-interactive) in a
// throwaway scratch directory, then shipping the files it wrote back as data.
// The daemon never gives pi a path into the live tree: the artifact is written
// into PI_SANDBOX by PiToolBuilder itself, containment-checked per file.
//
// Wire-up: PI_COMMAND="node scripts/pi-build.mjs"
//
// pi is pointed at the same MODEL_ENDPOINT the daemon uses (contracts not
// products): a private PI_CODING_AGENT_DIR is generated per build with a
// models.json declaring MODEL_ENDPOINT as an openai-completions provider, so
// the user's ~/.pi configuration is never read or touched.
//
// Env (all inherited from the daemon, which loads .env):
//   MODEL_ENDPOINT       OpenAI-compatible base URL   (default http://localhost:11434)
//   MODEL_NAME           model id to build with        (default local)
//   MODEL_MAX_TOKENS     completion budget for pi      (default 4096)
//   PI_BIN               the pi executable             (default pi; tests point this at a faux pi)
//   PI_BUILD_TIMEOUT_MS  hard ceiling on the pi run    (default 540000)
//
// A semantic failure (pi died, no files, manifest invalid, spec test failed)
// exits 0 with { ok:false, error } — the daemon logs it and enqueues nothing.
// A non-zero exit means the adapter itself broke.
// =============================================================================

import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';

const PROVIDER = 'saoirse';
const MAX_FILE_BYTES = 256 * 1024;
const MAX_RATIONALE_CHARS = 4000;
const SKIP_DIRS = new Set(['node_modules', '.git', '.pi']);

/** Mirror of safeToolName in src/core/tool-builder.ts — one safe path segment. */
function safeToolName(name) {
  const cleaned = String(name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .replace(/-+/g, '-');
  if (!cleaned || cleaned === '.' || cleaned === '..') {
    throw new Error(`invalid tool name: "${name}"`);
  }
  return cleaned;
}

function readStdin() {
  return new Promise((resolvePromise, rejectPromise) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolvePromise(data));
    process.stdin.on('error', rejectPromise);
  });
}

/** MODEL_ENDPOINT with or without /v1 — pi's baseUrl wants the /v1 form. */
function normalizeBaseUrl(endpoint) {
  const base = endpoint.replace(/\/+$/, '');
  return base.endsWith('/v1') ? base : `${base}/v1`;
}

/** The build brief pi gets. The manifest contract here mirrors src/core/skills.ts. */
function buildPrompt(toolName, spec) {
  return [
    `Build a Saoirse skill named "${toolName}" in the CURRENT DIRECTORY.`,
    '',
    `What it must do: ${spec.description}`,
    '',
    'A skill is a directory holding exactly these pieces:',
    '',
    '1. `skill.json` — the manifest. It MUST be valid JSON of this shape:',
    '   {',
    `     "name": "${toolName}",                      // EXACTLY this string`,
    '     "description": "<one sentence the model sees when deciding to call it>",',
    '     "entry": "run.mjs",',
    '     "parameters": { "type": "object", "properties": { ... }, "required": [...] },',
    '     "timeoutMs": 30000',
    '   }',
    '   "parameters" is the JSON Schema for the tool-call arguments. If the skill',
    '   takes no arguments use {"type":"object","properties":{},"required":[]}.',
    '',
    '2. `run.mjs` — the entry script. Contract:',
    '   - It is executed with plain `node run.mjs`, cwd = the skill directory.',
    '   - The tool-call arguments arrive as a single JSON object on STDIN.',
    '   - It writes its result as JSON to STDOUT and exits 0.',
    '   - On failure it writes a JSON {"error": "..."} to STDOUT and exits 1.',
    '   - Node 20, ES modules, NO dependencies — only node: built-ins. Never',
    '     install packages; there is no node_modules at run time.',
    '',
    'Rules:',
    '- Write files ONLY in the current directory (the skill directory itself).',
    '- Do not create package.json, node_modules, git repos, or stray files.',
    '- Keep it minimal: skill.json + run.mjs unless a helper module is essential.',
    spec.test
      ? `- This command must pass when run in the directory afterwards: ${spec.test}`
      : '',
    '',
    'When done, briefly state what you built and why it satisfies the spec.',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

/** Run pi non-interactively in `cwd`; resolves {code, stdout, stderr}. */
function runPi(piBin, args, cwd, env, timeoutMs) {
  return new Promise((resolvePromise, rejectPromise) => {
    // PI_BIN splits on spaces like PI_COMMAND does (e.g. "node fakepi.cjs" in
    // tests). .cmd shims (the npm-installed pi on Windows) only spawn through
    // a shell. Every argument we pass is a simple token (no spaces/quotes), so
    // this is safe even with shell quoting semantics.
    const [cmd, ...binArgs] = piBin.split(/\s+/);
    const shell = process.platform === 'win32';
    const child = spawn(cmd, [...binArgs, ...args], {
      cwd,
      env,
      shell,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => {
      clearTimeout(timer);
      rejectPromise(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) rejectPromise(new Error(`pi run timed out after ${timeoutMs}ms`));
      else resolvePromise({ code, stdout, stderr });
    });
  });
}

/** Run the spec's test command (shell) in the work dir. */
function runTest(command, cwd, timeoutMs = 120_000) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, { cwd, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolvePromise({ ok: false, output: `${output}\n(test timed out after ${timeoutMs}ms)` });
    }, timeoutMs);
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));
    child.on('error', (err) => {
      clearTimeout(timer);
      resolvePromise({ ok: false, output: `test spawn error: ${err.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ ok: code === 0, output: output.trim() || `(exit ${code})` });
    });
  });
}

/** Collect every file pi wrote, as {path, content} relative to workDir. */
async function collectFiles(workDir) {
  const files = [];
  async function walk(dir) {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(abs);
        continue;
      }
      const info = await stat(abs);
      if (info.size > MAX_FILE_BYTES) {
        throw new Error(
          `built file ${relative(workDir, abs)} is ${info.size} bytes — over the ${MAX_FILE_BYTES} byte skill ceiling`,
        );
      }
      files.push({
        path: relative(workDir, abs).split(sep).join('/'),
        content: await readFile(abs, 'utf8'),
      });
    }
  }
  await walk(workDir);
  return files;
}

/** Advisory mirror of the loader's manifest validation (src/core/skills.ts). */
function validateManifest(files, toolName) {
  const manifestFile = files.find((f) => f.path === 'skill.json');
  if (!manifestFile) return 'pi did not write a skill.json manifest';
  let manifest;
  try {
    manifest = JSON.parse(manifestFile.content);
  } catch {
    return 'skill.json is not valid JSON';
  }
  if (manifest.name !== toolName) {
    return `manifest "name" (${JSON.stringify(manifest.name)}) must be exactly "${toolName}"`;
  }
  if (typeof manifest.description !== 'string' || !manifest.description.trim()) {
    return 'manifest "description" must be a non-empty string';
  }
  if (typeof manifest.entry !== 'string' || !files.some((f) => f.path === manifest.entry)) {
    return `manifest "entry" (${JSON.stringify(manifest.entry)}) does not name a built file`;
  }
  if (
    manifest.parameters !== undefined &&
    (typeof manifest.parameters !== 'object' ||
      manifest.parameters === null ||
      Array.isArray(manifest.parameters))
  ) {
    return 'manifest "parameters" must be a JSON Schema object';
  }
  return undefined;
}

function emit(result) {
  process.stdout.write(JSON.stringify(result));
}

async function main() {
  // A BOM (U+FEFF) sneaks in when the spec is piped from PowerShell — strip it.
  const BOM = String.fromCharCode(0xfeff);
  const spec = JSON.parse((await readStdin()).replace(BOM, ''));
  const toolName = safeToolName(spec.name);

  const endpoint = process.env.MODEL_ENDPOINT || 'http://localhost:11434';
  const modelName = process.env.MODEL_NAME || 'local';
  const maxTokens = parseInt(process.env.MODEL_MAX_TOKENS ?? '4096', 10) || 4096;
  const piBin = process.env.PI_BIN || 'pi';
  const timeoutMs = parseInt(process.env.PI_BUILD_TIMEOUT_MS ?? '540000', 10) || 540_000;

  const scratch = await mkdtemp(join(tmpdir(), `saoirse-pi-${toolName}-`));
  try {
    // Private pi config: our provider, our endpoint, nothing of the user's.
    const configDir = join(scratch, 'pi-config');
    await mkdir(configDir, { recursive: true });
    await writeFile(
      join(configDir, 'models.json'),
      JSON.stringify(
        {
          providers: {
            [PROVIDER]: {
              name: 'Saoirse model endpoint',
              baseUrl: normalizeBaseUrl(endpoint),
              api: 'openai-completions',
              apiKey: 'local',
              models: [{ id: modelName, name: modelName, maxTokens }],
            },
          },
        },
        null,
        2,
      ),
    );

    // The skill directory pi works in — collected wholesale afterwards.
    const workDir = join(scratch, 'work');
    await mkdir(workDir);
    await writeFile(join(workDir, 'PROMPT.saoirse.md'), buildPrompt(toolName, spec));

    const piResult = await runPi(
      piBin,
      [
        '-p',
        '--no-session',
        '--no-extensions',
        '--no-skills',
        '--no-prompt-templates',
        '--no-themes',
        '--no-context-files',
        '--provider',
        PROVIDER,
        '--model',
        modelName,
        // One @file + one single-token message: with shell:true (the Windows
        // .cmd shim path) args are joined unquoted, so nothing here may
        // contain spaces. The brief itself travels in the attached file.
        '@PROMPT.saoirse.md',
        'proceed',
      ],
      workDir,
      {
        ...process.env,
        PI_CODING_AGENT_DIR: configDir,
        PI_OFFLINE: '1', // no self-update or other startup network ops
      },
      timeoutMs,
    );

    const rationale = piResult.stdout.trim().slice(-MAX_RATIONALE_CHARS);
    if (piResult.code !== 0) {
      emit({
        ok: false,
        files: [],
        rationale,
        error: `pi exited ${piResult.code}: ${(piResult.stderr || piResult.stdout).trim().slice(-2000)}`,
      });
      return;
    }

    await rm(join(workDir, 'PROMPT.saoirse.md'), { force: true });
    const files = await collectFiles(workDir);
    if (files.length === 0) {
      emit({ ok: false, files: [], rationale, error: 'pi wrote no files' });
      return;
    }

    const manifestProblem = validateManifest(files, toolName);
    if (manifestProblem) {
      emit({ ok: false, files, rationale, error: `built artifact is not a loadable skill: ${manifestProblem}` });
      return;
    }

    let testOutput = '(no tests run)';
    if (spec.test) {
      const test = await runTest(spec.test, workDir);
      testOutput = test.output;
      if (!test.ok) {
        emit({ ok: false, files, rationale, testOutput, error: `spec test failed: ${spec.test}` });
        return;
      }
    }

    emit({
      ok: true,
      files,
      diff: files.map((f) => `+ ${f.path} (${Buffer.byteLength(f.content)} bytes)`).join('\n'),
      testOutput,
      rationale,
    });
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((err) => {
  // Adapter breakage (not a build failure): still emit the contract shape so
  // the daemon logs one precise line, then exit non-zero.
  emit({ ok: false, files: [], error: `pi-build adapter error: ${err.message}` });
  process.exit(1);
});
