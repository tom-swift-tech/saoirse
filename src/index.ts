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
import { loadSkills } from './core/skills.js';
import { ProcessSkillRunner } from './core/skill-runner.js';
import { SaoirseCore, type SkillKit, type ToolKit } from './core/saoirse.js';
import { createRouter } from './channels/http.js';
import { attachWebSocket } from './channels/ws.js';
import { attachNats, type NatsChannel } from './channels/nats.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const proposalsDir = join(__dirname, '..', 'proposals');
const skillsDir = join(__dirname, '..', 'skills');

function readVersion(): string {
  try {
    const pkg = readFileSync(join(__dirname, '..', 'package.json'), 'utf8');
    return (JSON.parse(pkg) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
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

  const core = new SaoirseCore(memory, gateway, toolKit, skillKit);

  const version = readVersion();
  const server = http.createServer(
    createRouter({
      core,
      proposalsDir,
      skillsDir,
      sandboxDir,
      token: config.token,
      status: async () => ({
        model: {
          name: config.modelName,
          endpoint: config.modelEndpoint,
          reachable: await probeReachable(config.modelEndpoint),
        },
        skills: {
          count: skillKit.skills.length,
          names: core.skillNames,
        },
        version,
      }),
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
      `[saoirse] MODEL_ENDPOINT=${config.modelEndpoint}  MODEL_NAME=${config.modelName}  ENGRAM_DB=${config.engramDb}  embeddings=${config.engramEmbeddings}`,
    );
    console.log(
      `[saoirse] tool-builder: ${
        toolKit ? `pi (sandbox ${sandboxDir})` : 'disabled (PI_COMMAND unset)'
      }  — promotion is token-gated`,
    );
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
