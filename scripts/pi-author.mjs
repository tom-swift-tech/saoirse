// =============================================================================
// pi-author.mjs — The pi side of the Engram-Author contract (Tier 0, authoring).
//
// PiEngramAuthor (src/core/engram-author.ts) clones Engram, spawns this adapter
// with cwd = the clone, and a JSON change spec { description, test? } on stdin.
// This adapter drives the real pi coding agent (`pi -p`, non-interactive) to EDIT
// THE CLONE IN PLACE, then emits { ok, rationale, error? } on stdout. Unlike
// pi-build.mjs it collects NO files and runs NO git — the daemon owns the clone,
// the commit, the diff, and the test run. This adapter only makes the edits.
//
// Wire-up: PI_AUTHOR_COMMAND="node scripts/pi-author.mjs"
//
// pi is pointed at the same MODEL_ENDPOINT the daemon uses (contracts not
// products): a private PI_CODING_AGENT_DIR is generated per run with a models.json
// declaring MODEL_ENDPOINT as an openai-completions provider, so the user's ~/.pi
// is never read or touched.
//
// Env (inherited from the daemon, which loads .env):
//   MODEL_ENDPOINT        OpenAI-compatible base URL    (default http://localhost:11434)
//   MODEL_NAME            model id to author with        (default local)
//   MODEL_MAX_TOKENS      completion budget for pi       (default 4096)
//   PI_AUTHOR_BIN         the pi executable              (default pi; tests point at a faux pi)
//   PI_AUTHOR_TIMEOUT_MS  hard ceiling on the pi run     (default 540000)
//
// A semantic failure (pi died, emitted nothing useful) exits 0 with
// { ok:false, error }. A non-zero exit means the adapter itself broke.
// =============================================================================

import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PROVIDER = 'saoirse';
const MAX_RATIONALE_CHARS = 4000;

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

/** The change brief pi gets. It works in the CURRENT DIRECTORY (the Engram clone). */
function authorPrompt(spec) {
  return [
    'You are editing the Engram source repository in the CURRENT DIRECTORY.',
    'Engram is a TypeScript memory engine (SQLite + sqlite-vec + FTS5).',
    '',
    `Make this change: ${spec.description}`,
    '',
    'Rules:',
    '- Edit the existing source in place. Make the SMALLEST change that does the job.',
    '- Keep the existing code style and conventions.',
    '- Do NOT weaken, skip, or delete existing tests to make them pass. If behaviour',
    '  changes, update tests honestly and add coverage for the new behaviour.',
    '- Do NOT run `npm install`, edit package.json dependencies, or touch .git.',
    '- Do NOT create stray files, scratch notes, or unrelated edits.',
    spec.test
      ? `- After your change, this must also pass: ${spec.test}`
      : '',
    '',
    'When done, briefly state what you changed and why it satisfies the request.',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

/** Run pi non-interactively in `cwd`; resolves {code, stdout, stderr}. */
function runPi(piBin, args, cwd, env, timeoutMs) {
  return new Promise((resolvePromise, rejectPromise) => {
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

function emit(result) {
  process.stdout.write(JSON.stringify(result));
}

async function main() {
  // A BOM (U+FEFF) sneaks in when the spec is piped from PowerShell — strip it.
  const BOM = String.fromCharCode(0xfeff);
  const spec = JSON.parse((await readStdin()).replace(BOM, ''));
  if (typeof spec.description !== 'string' || !spec.description.trim()) {
    emit({ ok: false, error: 'spec.description is required' });
    return;
  }

  const endpoint = process.env.MODEL_ENDPOINT || 'http://localhost:11434';
  const modelName = process.env.MODEL_NAME || 'local';
  const maxTokens = parseInt(process.env.MODEL_MAX_TOKENS ?? '4096', 10) || 4096;
  const piBin = process.env.PI_AUTHOR_BIN || 'pi';
  const timeoutMs = parseInt(process.env.PI_AUTHOR_TIMEOUT_MS ?? '540000', 10) || 540_000;

  // cwd is the Engram clone the daemon handed us. pi edits it in place.
  const cwd = process.cwd();
  const configRoot = await mkdtemp(join(tmpdir(), 'saoirse-pi-author-'));
  try {
    const configDir = join(configRoot, 'pi-config');
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

    // The brief travels in an attached file (single-token args only — Windows
    // .cmd shim joins args unquoted; nothing here may contain spaces).
    const briefPath = join(cwd, 'PROMPT.saoirse.md');
    await writeFile(briefPath, authorPrompt(spec));

    let piResult;
    try {
      piResult = await runPi(
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
          '@PROMPT.saoirse.md',
          'proceed',
        ],
        cwd,
        {
          ...process.env,
          PI_CODING_AGENT_DIR: configDir,
          PI_OFFLINE: '1',
        },
        timeoutMs,
      );
    } finally {
      // The brief is not part of the change — remove it before the daemon diffs.
      await rm(briefPath, { force: true }).catch(() => {});
    }

    const rationale = piResult.stdout.trim().slice(-MAX_RATIONALE_CHARS);
    if (piResult.code !== 0) {
      emit({
        ok: false,
        rationale,
        error: `pi exited ${piResult.code}: ${(piResult.stderr || piResult.stdout).trim().slice(-2000)}`,
      });
      return;
    }
    emit({ ok: true, rationale });
  } finally {
    await rm(configRoot, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((err) => {
  emit({ ok: false, error: `pi-author adapter error: ${err.message}` });
  process.exit(1);
});
