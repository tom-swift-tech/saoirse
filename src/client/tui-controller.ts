// =============================================================================
// tui-controller.ts — Headless dashboard state + actions for the Saoirse TUI.
//
// A CLIENT: it talks ONLY to SaoirseClient (the wire layer). It holds no daemon
// logic — it sends over the contract and projects the responses into pane text.
// Kept separate from the pi-tui rendering so the behaviour is unit-testable
// without a terminal. Imports nothing from core/, memory, Engram, or the gateway.
// =============================================================================

import {
  DaemonHttpError,
  DaemonUnreachableError,
  type PushEvent,
  type SaoirseClient,
  type StatusResponse,
} from './client.js';

export interface ConversationLine {
  role: 'you' | 'saoirse' | 'system';
  text: string;
}

export interface DashboardState {
  conversation: ConversationLine[];
  status: StatusResponse | null;
  /** Whether the daemon itself answered the last poll. */
  connected: boolean;
  tokenPresent: boolean;
  /** Memories surfaced on the most recent turn (null = no turn yet). */
  lastRecallCount: number | null;
  proposals: string[];
  pushLog: string[];
  busy: boolean;
}

export interface ControllerOptions {
  baseUrl: string;
  tokenPresent: boolean;
  /** Called after any state change so the view can re-render. */
  onChange?: () => void;
}

const PUSH_LOG_CAP = 20;

export class DashboardController {
  readonly state: DashboardState = {
    conversation: [],
    status: null,
    connected: false,
    tokenPresent: false,
    lastRecallCount: null,
    proposals: [],
    pushLog: [],
    busy: false,
  };

  constructor(
    private readonly client: SaoirseClient,
    private readonly opts: ControllerOptions,
  ) {
    this.state.tokenPresent = opts.tokenPresent;
  }

  // --- actions --------------------------------------------------------------

  /** Route a line of input: slash-commands vs a chat turn. */
  async submit(input: string): Promise<void> {
    const text = input.trim();
    if (!text) return;
    if (text.startsWith('/')) return this.command(text);
    return this.send(text);
  }

  private async command(text: string): Promise<void> {
    const [cmd, id] = text.slice(1).split(/\s+/);
    if (cmd === 'approve' || cmd === 'reject') {
      if (!id) {
        this.sys(`usage: /${cmd} <proposal-id>`);
        return;
      }
      return cmd === 'approve' ? this.approve(id) : this.reject(id);
    }
    if (cmd === 'help') {
      this.sys(
        'commands: /approve <id>, /reject <id>, /help — or just type to chat',
      );
      return;
    }
    this.sys(`unknown command: /${cmd}`);
  }

  async send(text: string): Promise<void> {
    this.addLine('you', text);
    this.state.busy = true;
    this.changed();
    try {
      const res = await this.client.message(text);
      this.addLine('saoirse', String(res.reply ?? ''));
      const recall = res.recall as { count?: number } | undefined;
      this.state.lastRecallCount =
        typeof recall?.count === 'number' ? recall.count : 0;
      this.setConnected(true);
    } catch (err) {
      this.reportError(err);
    } finally {
      this.state.busy = false;
      this.changed();
    }
  }

  async refreshStatus(): Promise<void> {
    try {
      this.state.status = await this.client.status();
      this.setConnected(true);
    } catch (err) {
      // Daemon unreachable => disconnected; keep last-known model info.
      if (err instanceof DaemonUnreachableError) this.setConnected(false);
      else this.reportError(err);
    }
  }

  async refreshProposals(): Promise<void> {
    try {
      const queue = await this.client.proposals();
      this.state.proposals = (queue.proposals as Array<{ name?: string }>)
        .map((p) => p.name ?? '(unnamed)')
        .filter(Boolean);
      this.setConnected(true);
    } catch (err) {
      if (err instanceof DaemonUnreachableError) this.setConnected(false);
      else this.reportError(err);
    }
  }

  async approve(id: string): Promise<void> {
    if (!this.state.tokenPresent) {
      this.sys(`✖ /approve needs SAOIRSE_TOKEN — fail-closed, not sent`);
      return;
    }
    try {
      const r = await this.client.approve(id);
      this.sys(`✓ approved ${id} → ${String(r.promoted ?? r.toolName ?? '')}`);
      await this.refreshProposals();
    } catch (err) {
      this.reportError(err);
    }
  }

  async reject(id: string): Promise<void> {
    if (!this.state.tokenPresent) {
      this.sys(`✖ /reject needs SAOIRSE_TOKEN — fail-closed, not sent`);
      return;
    }
    try {
      await this.client.reject(id);
      this.sys(`✓ rejected ${id}`);
      await this.refreshProposals();
    } catch (err) {
      this.reportError(err);
    }
  }

  pushEvent(event: PushEvent): void {
    const when = typeof event.ts === 'number' ? ` @${event.ts}` : '';
    this.state.pushLog.push(`${event.type}${when}`);
    if (this.state.pushLog.length > PUSH_LOG_CAP) {
      this.state.pushLog.splice(0, this.state.pushLog.length - PUSH_LOG_CAP);
    }
    this.changed();
  }

  setConnected(connected: boolean): void {
    if (this.state.connected !== connected) {
      this.state.connected = connected;
      this.changed();
    } else {
      this.state.connected = connected;
    }
  }

  // --- view projections (pure text; the view adds colour) -------------------

  modelPane(): string {
    const m = this.state.status?.model;
    if (!m) return 'Model: (unknown — awaiting status)';
    return `Model: ${m.name} @ ${m.endpoint}  [${m.reachable ? '● online' : '○ offline'}]`;
  }

  memoryPane(): string {
    const c = this.state.lastRecallCount;
    return `Memory: ${c == null ? 'no turns yet' : `${c} recalled last turn`}`;
  }

  proposalsPane(): string[] {
    const lines = [`Proposals: ${this.state.proposals.length} pending`];
    for (const name of this.state.proposals) lines.push(`  - ${name}`);
    return lines;
  }

  connectionLine(): string {
    const dot = this.state.connected ? '● connected' : '○ disconnected';
    return `${dot} ${this.opts.baseUrl}  | token: ${this.state.tokenPresent ? 'yes' : 'no'}`;
  }

  pushLine(): string {
    return `push: ${this.state.pushLog.at(-1) ?? '(none)'}`;
  }

  conversationLines(): string[] {
    const out: string[] = [];
    for (const line of this.state.conversation) {
      const label =
        line.role === 'you'
          ? 'you'
          : line.role === 'saoirse'
            ? 'saoirse'
            : '··';
      const parts = line.text.split('\n');
      out.push(`${label}> ${parts[0] ?? ''}`);
      for (const extra of parts.slice(1)) out.push(`     ${extra}`);
    }
    return out;
  }

  // --- internals ------------------------------------------------------------

  private addLine(role: ConversationLine['role'], text: string): void {
    this.state.conversation.push({ role, text });
  }

  private sys(text: string): void {
    this.addLine('system', text);
    this.changed();
  }

  private reportError(err: unknown): void {
    if (err instanceof DaemonUnreachableError) {
      this.setConnected(false);
      this.sys(`✖ Saoirse core not reachable at ${this.opts.baseUrl}`);
    } else if (err instanceof DaemonHttpError) {
      this.sys(`✖ error (HTTP ${err.status}): ${err.body}`);
    } else {
      this.sys(`✖ ${(err as Error).message ?? String(err)}`);
    }
  }

  private changed(): void {
    this.opts.onChange?.();
  }
}
