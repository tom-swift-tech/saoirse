// =============================================================================
// index.ts — The daemon. Wires config -> core -> channels and listens.
//
// One core, two thin north-facing transports (HTTP + WS). The core is built
// from seams (Memory over pinned Engram, ModelGateway over an OpenAI-compatible
// endpoint) so the future
// CLI/TUI spoke reuses it untouched.
// =============================================================================

import http from 'http';
import { readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { loadDotenv } from './load-env.js';
import { loadConfig } from './config.js';
import { createEngram } from './core/engram-factory.js';
import { EngramMemory } from './core/memory.js';
import { OpenAICompatibleGateway } from './core/openai-compatible-gateway.js';
import { PiToolBuilder } from './core/pi-tool-builder.js';
import { GitEngramEvaluator } from './core/engram-evaluator.js';
import { PiEngramAuthor, type EngramAuthor } from './core/engram-author.js';
import { loadSkills } from './core/skills.js';
import { ProcessSkillRunner } from './core/skill-runner.js';
import {
  SaoirseCore,
  type EngramKit,
  type SkillKit,
  type ToolKit,
} from './core/saoirse.js';
import { parseEngramPin } from './proposals.js';
import { createRouter } from './channels/http.js';
import { attachWebSocket } from './channels/ws.js';
import { attachNats, type NatsChannel } from './channels/nats.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const proposalsDir = join(__dirname, '..', 'proposals');
const skillsDir = join(__dirname, '..', 'skills');
const packageJsonPath = join(__dirname, '..', 'package.json');

function readPackageJson(): {
  version?: string;
  dependencies?: Record<string, string>;
} {
  try {
    return JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  } catch {
    return {};
  }
}

/** Cheap reachability probe: any HTTP response within the timeout = reachable. */
async function probeReachable(endpoint: string): Promise<boolean> {
  const base = endpoint.replace(/\/+$/, '').replace(/\/v1$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    await fetch(`${base}/v1/models`, { signal: controller.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Reachability probe for the Ollama embeddings endpoint.
 *
 * Engram's embeddings target engramEmbeddingsUrl, which is INDEPENDENT of
 * MODEL_ENDPOINT. Chat can succeed while recall silently degrades when the
 * two services diverge. This probe makes that divergence observable.
 *
 * Modelled exactly on probeReachable: AbortController + ~1.5 s timeout +
 * catch → false. Must NEVER block boot or throw — returns false on any error.
 */
async function probeEmbeddingsReachable(baseUrl: string): Promise<boolean> {
  const base = baseUrl.replace(/\/+$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    await fetch(`${base}/api/tags`, { signal: controller.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  // Load .env from the working directory first; shell env still wins.
  loadDotenv();
  const config = loadConfig();

  if (!config.token) {
    console.warn(
      '[saoirse] SAOIRSE_TOKEN is not set — the WS push channel will reject every connection.',
    );
  }

  const engram = await createEngram(config);
  const memory = new EngramMemory(engram);
  const gateway = new OpenAICompatibleGateway({
    url: config.modelEndpoint,
    model: config.modelName,
    maxTokens: config.modelMaxTokens,
  });

  // Tier-1 Tool-Builder: only wired when PI_COMMAND is configured. The builder
  // gets the sandbox; the core gets proposalsDir but NOT skillsDir — it can
  // accrete a proposal, never promote one.
  const sandboxDir = resolve(config.piSandbox);
  let toolKit: ToolKit | undefined;
  if (config.piCommand) {
    const builder = new PiToolBuilder({
      command: config.piCommand,
      sandboxRoot: sandboxDir,
      timeoutMs: config.piTimeoutMs,
    });
    toolKit = { builder, proposalsDir };
  }
  // Committed skills: loaded ONCE, from the directory only the token-gated
  // promotion writes. A bad manifest is reported and skipped — one broken
  // capability never takes the daemon down (SYSTEM.md Tier 1).
  const skillReport = await loadSkills(skillsDir);
  for (const problem of skillReport.errors) {
    console.warn(`[saoirse] skill skipped: ${problem}`);
  }
  const skillKit: SkillKit = {
    skills: skillReport.skills,
    runner: new ProcessSkillRunner(),
  };

  // Tier-0 Engram evaluator: the pin in package.json is the single source of
  // truth for what the daemon runs on. We parse it to learn the clone source and
  // the current SHA; the kit can evaluate + propose, never re-pin. A malformed
  // pin disables Tier-0 (loudly) rather than crashing boot.
  const pkg = readPackageJson();
  let engramKit: EngramKit | undefined;
  let engramTier0Note = 'disabled (no parseable engram pin)';
  try {
    const pin = parseEngramPin(pkg.dependencies?.engram ?? '');
    const evaluator = new GitEngramEvaluator({
      repoUrl: config.engramRepo ?? pin.repoUrl,
      sandboxRoot: resolve(config.engramEvalSandbox),
      currentSha: pin.sha,
      baselineTestCount: config.engramBaselineTests,
      timeoutMs: config.engramEvalTimeoutMs,
    });
    // Tier-0 authoring (pi-on-Engram): wired only when PI_AUTHOR_COMMAND is set.
    // Author-only — it produces a reviewable local branch, never pushes.
    let author: EngramAuthor | undefined;
    if (config.piAuthorCommand) {
      author = new PiEngramAuthor({
        command: config.piAuthorCommand,
        repoUrl: config.engramRepo ?? pin.repoUrl,
        baseSha: pin.sha,
        sandboxRoot: resolve(config.engramAuthorSandbox),
        baselineTestCount: config.engramBaselineTests,
        timeoutMs: config.engramAuthorTimeoutMs,
      });
    }
    engramKit = {
      evaluator,
      author,
      proposalsDir,
      currentSha: pin.sha,
      baselineTestCount: config.engramBaselineTests,
    };
    engramTier0Note =
      `evaluate-and-repin (pinned ${pin.sha.slice(0, 7)}, baseline ${config.engramBaselineTests})` +
      `; authoring ${author ? 'enabled' : 'disabled (PI_AUTHOR_COMMAND unset)'}`;
  } catch (err) {
    console.warn(
      `[saoirse] Tier-0 Engram evaluation disabled: ${(err as Error).message}`,
    );
  }

  const core = new SaoirseCore(memory, gateway, toolKit, skillKit, engramKit);

  const version = pkg.version ?? '0.0.0';
  const server = http.createServer(
    createRouter({
      core,
      proposalsDir,
      skillsDir,
      sandboxDir,
      packageJsonPath,
      engramEvalSandbox: resolve(config.engramEvalSandbox),
      engramAuthorSandbox: resolve(config.engramAuthorSandbox),
      token: config.token,
      status: async () => {
        // Probe model + embeddings concurrently so /status stays responsive
        // even when both are unreachable (each probe is bounded at ~1.5 s).
        // Embeddings is probed only in 'ollama' mode — in 'offline'/'local'
        // there is no independent Ollama to reach (null = n/a).
        const [modelReachable, embeddingsReachable] = await Promise.all([
          probeReachable(config.modelEndpoint),
          config.engramEmbeddings === 'ollama'
            ? probeEmbeddingsReachable(config.engramEmbeddingsUrl)
            : Promise.resolve(null),
        ]);
        return {
          model: {
            name: config.modelName,
            endpoint: config.modelEndpoint,
            reachable: modelReachable,
          },
          skills: {
            count: skillKit.skills.length,
            names: core.skillNames,
          },
          version,
          embeddings: {
            mode: config.engramEmbeddings,
            reachable: embeddingsReachable,
          },
        };
      },
    }),
  );
  attachWebSocket(server, { token: config.token });

  // East-west fabric: only joined when NATS_URL is configured (no fabric, no
  // import). The nats package is loaded lazily so a daemon outside the fabric
  // never touches it. Agents/services only — humans use HTTP/WS.
  let natsChannel: NatsChannel | undefined;
  if (config.natsUrl) {
    try {
      const { connect } = await import('nats');
      const connection = await connect({
        servers: config.natsUrl,
        name: 'saoirse-core',
      });
      natsChannel = attachNats({
        core,
        connection,
        prefix: config.natsPrefix,
      });
      console.log(
        `[saoirse] east-west fabric joined: ${config.natsUrl} (request/reply on ${natsChannel.subject})`,
      );
    } catch (err) {
      // The fabric being down must never take the north-facing channels with
      // it — report loudly and serve HTTP/WS as normal.
      console.error(
        `[saoirse] could not join the east-west fabric at ${config.natsUrl}:`,
        (err as Error).message,
      );
    }
  }

  // A listen failure (port in use, no permission) arrives as an 'error' event;
  // without a handler Node rethrows it as an unhandled-error crash. Report it
  // cleanly and exit non-zero instead.
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(
        `[saoirse] port ${config.port} is already in use — is another Saoirse daemon running? ` +
          'Stop it, or set PORT to a free port.',
      );
    } else {
      console.error('[saoirse] server error:', err);
    }
    memory.close();
    process.exit(1);
  });

  server.listen(config.port, () => {
    console.log(
      `[saoirse] core listening on http://localhost:${config.port}  (HTTP + WS)`,
    );
    console.log(
      `[saoirse] MODEL_ENDPOINT=${config.modelEndpoint}  MODEL_NAME=${config.modelName}  ENGRAM_DB=${config.engramDb}`,
    );
    // Embeddings line: mode + target URL. The embeddings endpoint is independent
    // of MODEL_ENDPOINT — a mismatch degrades recall without a dedicated note.
    const embeddingsNote =
      config.engramEmbeddings === 'ollama'
        ? `ollama (${config.engramEmbeddingsUrl}) — probe on /status`
        : `${config.engramEmbeddings} (no reachability probe)`;
    console.log(`[saoirse] embeddings: ${embeddingsNote}`);
    console.log(
      `[saoirse] tool-builder: ${
        toolKit ? `pi (sandbox ${sandboxDir})` : 'disabled (PI_COMMAND unset)'
      }  — promotion is token-gated`,
    );
    console.log(`[saoirse] engram tier-0: ${engramTier0Note}  — re-pin is token-gated`);
    console.log(
      `[saoirse] skills: ${
        skillKit.skills.length
          ? skillKit.skills.map((s) => s.name).join(', ')
          : '(none committed)'
      }`,
    );
  });

  const shutdown = (): void => {
    console.log('[saoirse] shutting down…');
    server.close();
    void (natsChannel?.close() ?? Promise.resolve()).finally(() => {
      memory.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[saoirse] fatal:', err);
  if (String(err).includes('huggingface.co')) {
    console.error(
      '[saoirse] hint: the default local embedder needs to download a model. ' +
        'For offline/dev boot, set ENGRAM_EMBEDDINGS=offline.',
    );
  }
  process.exit(1);
});
