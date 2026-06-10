#!/usr/bin/env node
// =============================================================================
// cli.ts — the `saoirse` CLI/TUI spoke. A thin client over the daemon's API.
//
// Imports the wire contract only (./client + Node builtins). NOTHING from the
// core: no SaoirseCore, no Memory, no Engram, no gateway. This is the
// contract-validation spoke — if it works, the API boundary is real, and
// mobile/web/voice are the same shape.
//
// Modes:
//   saoirse "what's new"      one-shot: POST /message, print reply, exit
//   echo "..." | saoirse      one-shot from stdin
//   saoirse                   interactive REPL (readline) + WS push events
//   --json                    print the raw daemon response instead of prose
// =============================================================================

import * as readline from 'node:readline';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  SaoirseClient,
  DaemonUnreachableError,
  DaemonHttpError,
} from './client.js';

const DEFAULT_URL = 'http://localhost:8787';

export interface CliDeps {
  env: Record<string, string | undefined>;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  exit: (code: number) => void;
  /** Resolve piped stdin text, or null if there is no pipe (interactive TTY). */
  readStdin: () => Promise<string | null>;
  createClient: (opts: { baseUrl: string; token?: string }) => SaoirseClient;
  /** Drive the interactive REPL. Injectable so tests stay headless. */
  startRepl: (client: SaoirseClient, ctx: ReplContext) => Promise<void>;
}

export interface ReplContext {
  json: boolean;
  token: string | undefined;
  baseUrl: string;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

export async function main(argv: string[], deps: CliDeps): Promise<void> {
  const json = argv.includes('--json');
  const positional = argv.filter((a) => a !== '--json' && a !== '--');
  const baseUrl = deps.env.SAOIRSE_URL || DEFAULT_URL;
  const token = deps.env.SAOIRSE_TOKEN || undefined;
  const client = deps.createClient({ baseUrl, token });

  // Governance/tool subcommands take precedence over a one-shot message. They
  // only match when the FIRST token is exactly the keyword (a quoted message
  // like "build me X" arrives as one arg and won't collide).
  const [maybeCmd, ...cmdArgs] = positional;
  if (typeof maybeCmd === 'string' && SUBCOMMANDS.has(maybeCmd)) {
    return runSubcommand(maybeCmd, cmdArgs, { json, client, baseUrl, deps });
  }

  // Resolve the one-shot message: positional args, else piped stdin.
  let text: string | null = positional.length ? positional.join(' ') : null;
  if (text === null) {
    const piped = await deps.readStdin();
    if (piped && piped.trim()) text = piped.trim();
  }

  if (text !== null) {
    try {
      const res = await client.message(text);
      deps.stdout(json ? JSON.stringify(res) : String(res.reply ?? ''));
    } catch (err) {
      reportError(err, baseUrl, deps.stderr);
      deps.exit(1);
    }
    return;
  }

  // No message and no pipe → interactive REPL (the TUI seam).
  await deps.startRepl(client, {
    json,
    token,
    baseUrl,
    stdout: deps.stdout,
    stderr: deps.stderr,
  });
}

const SUBCOMMANDS = new Set(['build', 'proposals', 'approve', 'reject']);

interface SubcommandCtx {
  json: boolean;
  client: SaoirseClient;
  baseUrl: string;
  deps: CliDeps;
}

async function runSubcommand(
  cmd: string,
  args: string[],
  ctx: SubcommandCtx,
): Promise<void> {
  const { json, client, baseUrl, deps } = ctx;
  try {
    if (cmd === 'proposals') {
      const queue = await client.proposals();
      if (json) {
        deps.stdout(JSON.stringify(queue));
      } else {
        deps.stdout(`${queue.count} proposal(s) pending`);
        for (const p of queue.proposals as Array<{ name?: string }>) {
          deps.stdout(`  - ${p.name ?? '(unnamed)'}`);
        }
      }
      return;
    }
    if (cmd === 'build') {
      const name = args[0];
      const description = args.slice(1).join(' ');
      if (!name || !description) {
        deps.stderr('usage: saoirse build <name> <description...>');
        deps.exit(2);
        return;
      }
      const out = await client.build({ name, description });
      deps.stdout(
        json
          ? JSON.stringify(out)
          : `proposal ${out.proposalId ?? JSON.stringify(out)} — pending; approve to promote`,
      );
      return;
    }
    // approve | reject
    const id = args[0];
    if (!id) {
      deps.stderr(`usage: saoirse ${cmd} <proposal-id>`);
      deps.exit(2);
      return;
    }
    const out =
      cmd === 'approve' ? await client.approve(id) : await client.reject(id);
    deps.stdout(json ? JSON.stringify(out) : `${cmd}d ${id}`);
  } catch (err) {
    reportError(err, baseUrl, deps.stderr);
    deps.exit(1);
  }
}

export function reportError(
  err: unknown,
  baseUrl: string,
  stderr: (line: string) => void,
): void {
  if (err instanceof DaemonUnreachableError) {
    stderr(`Saoirse core not reachable at ${baseUrl} — is the daemon running?`);
  } else if (err instanceof DaemonHttpError) {
    stderr(`Saoirse core returned an error (HTTP ${err.status}): ${err.body}`);
  } else {
    stderr(`Unexpected error: ${(err as Error).message ?? String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Real-world deps (not exercised by the headless tests)
// ---------------------------------------------------------------------------

function defaultReadStdin(): Promise<string | null> {
  if (process.stdin.isTTY) return Promise.resolve(null);
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(null));
  });
}

async function defaultStartRepl(
  client: SaoirseClient,
  ctx: ReplContext,
): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'saoirse> ',
  });

  let push: { close(): void } | undefined;
  if (ctx.token) {
    push = client.connectPush({
      onEvent: (event) => {
        const when =
          typeof event.ts === 'number'
            ? ` ${new Date(event.ts).toISOString()}`
            : '';
        process.stdout.write(`\n[push] ${event.type}${when}\n`);
        rl.prompt();
      },
      onError: () => {
        /* push is best-effort; HTTP turns still work */
      },
    });
  } else {
    ctx.stderr('No SAOIRSE_TOKEN set — running HTTP-only (no push channel).');
  }

  ctx.stdout(`Connected to Saoirse at ${ctx.baseUrl}. Type "exit" to quit.`);
  rl.prompt();

  rl.on('line', async (line) => {
    const text = line.trim();
    if (text === 'exit' || text === 'quit') {
      rl.close();
      return;
    }
    if (!text) {
      rl.prompt();
      return;
    }
    try {
      const res = await client.message(text);
      ctx.stdout(ctx.json ? JSON.stringify(res) : String(res.reply ?? ''));
    } catch (err) {
      reportError(err, ctx.baseUrl, ctx.stderr);
    }
    rl.prompt();
  });

  rl.on('SIGINT', () => rl.close());

  await new Promise<void>((resolve) => {
    rl.on('close', () => {
      push?.close();
      resolve();
    });
  });
}

export function defaultDeps(): CliDeps {
  return {
    env: process.env,
    stdout: (line) => process.stdout.write(line + '\n'),
    stderr: (line) => process.stderr.write(line + '\n'),
    exit: (code) => process.exit(code),
    readStdin: defaultReadStdin,
    createClient: (opts) => new SaoirseClient(opts),
    startRepl: defaultStartRepl,
  };
}

function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main(process.argv.slice(2), defaultDeps()).catch((err) => {
    process.stderr.write(`Unexpected error: ${String(err)}\n`);
    process.exit(1);
  });
}
