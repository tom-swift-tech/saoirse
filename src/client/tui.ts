#!/usr/bin/env node
// =============================================================================
// tui.ts — the `saoirse-tui` dashboard spoke. A thin CLIENT over the daemon.
//
// Renders with @mariozechner/pi-tui (differential rendering) — conversation pane
// plus live Model / Memory / Proposals status panes, a push-log + connection
// line, and an input. All daemon talk goes through SaoirseClient; the dashboard
// state/actions live in DashboardController. Imports nothing from core/, memory,
// Engram, or the gateway — same structural boundary as the plain CLI spoke.
// =============================================================================

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Input, ProcessTerminal, Text, TUI } from '@mariozechner/pi-tui';
import { SaoirseClient } from './client.js';
import { DashboardController } from './tui-controller.js';

const DEFAULT_URL = 'http://localhost:8787';
const POLL_MS = 5000;
const RECONNECT_MS = 3000;

const RESET = '\x1b[0m';
const style = (code: string) => (s: string) => `${code}${s}${RESET}`;
const bold = style('\x1b[1m');
const dim = style('\x1b[2m');
const green = style('\x1b[32m');
const red = style('\x1b[31m');

export function runTui(env: NodeJS.ProcessEnv = process.env): void {
  const baseUrl = env.SAOIRSE_URL || DEFAULT_URL;
  const token = env.SAOIRSE_TOKEN || undefined;

  const client = new SaoirseClient({ baseUrl, token });
  const terminal = new ProcessTerminal();
  const tui = new TUI(terminal, true);
  const ctrl = new DashboardController(client, {
    baseUrl,
    tokenPresent: Boolean(token),
    onChange: () => rerender(),
  });

  const title = new Text(bold('Saoirse — dashboard'));
  const conn = new Text('');
  const model = new Text('');
  const memory = new Text('');
  const proposals = new Text('');
  const push = new Text('');
  const sep = new Text(dim('── conversation ───────────────'));
  const conversation = new Text('');
  const hint = new Text(
    dim('type to chat · /approve <id> · /reject <id> · exit'),
  );
  const input = new Input();

  for (const c of [
    title,
    conn,
    model,
    memory,
    proposals,
    push,
    sep,
    conversation,
    hint,
    input,
  ]) {
    tui.addChild(c);
  }
  tui.setFocus(input);

  function colourModel(): string {
    const base = ctrl.modelPane();
    if (!ctrl.state.status) return dim(base);
    return base
      .replace('● online', green('● online'))
      .replace('○ offline', red('○ offline'));
  }
  function colourConn(): string {
    const base = ctrl.connectionLine();
    return ctrl.state.connected
      ? base.replace('● connected', green('● connected'))
      : base.replace('○ disconnected', red('○ disconnected'));
  }

  let quitting = false;
  function rerender(): void {
    conn.setText(colourConn());
    model.setText(colourModel());
    memory.setText(ctrl.memoryPane());
    proposals.setText(ctrl.proposalsPane().join('\n'));
    push.setText(dim(ctrl.pushLine()));
    const rows = terminal.rows || 24;
    const windowSize = Math.max(3, rows - 12);
    conversation.setText(
      ctrl.conversationLines().slice(-windowSize).join('\n'),
    );
    tui.requestRender();
  }

  input.onSubmit = (value: string): void => {
    input.setValue('');
    const trimmed = value.trim();
    if (trimmed === 'exit' || trimmed === 'quit') {
      quit();
      return;
    }
    void ctrl.submit(value);
    rerender();
  };

  const removeGlobalKeys = tui.addInputListener((data: string) => {
    if (data === '\x03') {
      quit();
      return { consume: true };
    }
    return undefined;
  });

  let pushHandle: { close(): void } | undefined;
  function connectPush(): void {
    if (!token) {
      ctrl.pushEvent({ type: 'push disabled (no SAOIRSE_TOKEN)' });
      return;
    }
    pushHandle = client.connectPush({
      onOpen: () => {
        ctrl.setConnected(true);
        rerender();
      },
      onEvent: (event) => {
        ctrl.pushEvent(event);
        rerender();
      },
      onError: () => {
        /* best-effort; HTTP polling continues */
      },
      onClose: () => {
        if (quitting) return;
        ctrl.setConnected(false);
        rerender();
        setTimeout(connectPush, RECONNECT_MS);
      },
    });
  }

  const poll = setInterval(() => {
    void ctrl.refreshStatus();
    void ctrl.refreshProposals();
  }, POLL_MS);

  function quit(): void {
    if (quitting) return;
    quitting = true;
    clearInterval(poll);
    removeGlobalKeys();
    pushHandle?.close();
    tui.stop();
    process.exit(0);
  }
  process.on('SIGINT', quit);
  process.on('SIGTERM', quit);

  tui.start();
  rerender();
  void ctrl.refreshStatus();
  void ctrl.refreshProposals();
  connectPush();
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
  runTui();
}
