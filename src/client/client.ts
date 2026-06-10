// =============================================================================
// client.ts — Saoirse wire-contract client.
//
// A CLIENT. It speaks the daemon's north-facing HTTP/WS contract and imports
// NOTHING from the core (no SaoirseCore, no Memory, no Engram, no gateway). The
// only dependency beyond Node builtins is `ws`, a transport library — the same
// wire the server speaks, not core logic. This boundary is the architecture:
// every spoke is a thin client over the same API.
//
// Contract (see docs/ARCHITECTURE.md):
//   POST {base}/message {text} -> { reply }            (200; {error} on 4xx/5xx)
//   WS   {base->ws}/ws  (auth: Authorization: Bearer)  -> {type:'hello'|'heartbeat',...}
// =============================================================================

import WebSocket from 'ws';

export interface MessageResponse {
  reply?: string;
  [key: string]: unknown;
}

export interface PushEvent {
  type: string;
  [key: string]: unknown;
}

export interface StatusResponse {
  model: { name: string; endpoint: string; reachable: boolean };
  version: string;
}

export interface PushHandlers {
  onEvent: (event: PushEvent) => void;
  onOpen?: () => void;
  onError?: (err: unknown) => void;
  onClose?: () => void;
}

export interface PushHandle {
  close(): void;
}

/** Minimal socket surface the client needs — `ws.WebSocket` satisfies it. */
export interface SocketLike {
  on(event: string, listener: (...args: unknown[]) => void): void;
  close(): void;
}

export type SocketFactory = (
  url: string,
  options: { headers?: Record<string, string> },
) => SocketLike;

export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/** The daemon could not be reached at all (network error / refused). */
export class DaemonUnreachableError extends Error {
  constructor(
    readonly baseUrl: string,
    readonly cause?: unknown,
  ) {
    super(`Saoirse core not reachable at ${baseUrl}`);
    this.name = 'DaemonUnreachableError';
  }
}

/** The daemon was reached but returned a non-2xx response. */
export class DaemonHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`Saoirse core returned HTTP ${status}`);
    this.name = 'DaemonHttpError';
  }
}

export interface SaoirseClientOptions {
  baseUrl: string;
  token?: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: FetchLike;
  /** Injectable for tests; defaults to a real `ws` WebSocket. */
  socketFactory?: SocketFactory;
}

const defaultSocketFactory: SocketFactory = (url, options) =>
  new WebSocket(url, options) as unknown as SocketLike;

export class SaoirseClient {
  private readonly baseUrl: string;
  private readonly token: string | undefined;
  private readonly fetchImpl: FetchLike;
  private readonly socketFactory: SocketFactory;

  constructor(opts: SaoirseClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.token = opts.token;
    this.fetchImpl =
      opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    this.socketFactory = opts.socketFactory ?? defaultSocketFactory;
  }

  /** POST a turn to /message and return the parsed daemon response. */
  async message(text: string): Promise<MessageResponse> {
    let res: { ok: boolean; status: number; text(): Promise<string> };
    try {
      res = await this.fetchImpl(`${this.baseUrl}/message`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      });
    } catch (err) {
      throw new DaemonUnreachableError(this.baseUrl, err);
    }

    const raw = await res.text();
    let parsed: MessageResponse;
    try {
      parsed = raw ? (JSON.parse(raw) as MessageResponse) : {};
    } catch {
      throw new DaemonHttpError(res.status, raw);
    }
    if (!res.ok) {
      const detail =
        typeof parsed.error === 'string' ? parsed.error : raw || '';
      throw new DaemonHttpError(res.status, detail);
    }
    return parsed;
  }

  /** GET /status — model name/endpoint/reachability + daemon version (open). */
  async status(): Promise<StatusResponse> {
    return (await this.request('GET', '/status')) as unknown as StatusResponse;
  }

  /** GET /proposals — the governance queue (read-only, open). */
  async proposals(): Promise<{ count: number; proposals: unknown[] }> {
    return this.request('GET', '/proposals') as Promise<{
      count: number;
      proposals: unknown[];
    }>;
  }

  /** POST /build — accrete a sandboxed tool proposal (privileged; needs the token). */
  async build(spec: {
    name: string;
    description: string;
    test?: string;
  }): Promise<Record<string, unknown>> {
    return this.request('POST', '/build', spec);
  }

  /** POST /proposals/:id/approve — the gate. Promotes the artifact (privileged). */
  async approve(id: string): Promise<Record<string, unknown>> {
    return this.request('POST', `/proposals/${encodeURIComponent(id)}/approve`);
  }

  /** POST /proposals/:id/reject — discard the sandboxed artifact (privileged). */
  async reject(id: string): Promise<Record<string, unknown>> {
    return this.request('POST', `/proposals/${encodeURIComponent(id)}/reject`);
  }

  /** Shared request helper: attaches the Bearer token, maps errors to typed ones. */
  private async request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    let res: { ok: boolean; status: number; text(): Promise<string> };
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      throw new DaemonUnreachableError(this.baseUrl, err);
    }
    const raw = await res.text();
    let parsed: Record<string, unknown>;
    try {
      parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    } catch {
      throw new DaemonHttpError(res.status, raw);
    }
    if (!res.ok) {
      const detail =
        typeof parsed.error === 'string' ? parsed.error : raw || '';
      throw new DaemonHttpError(res.status, detail);
    }
    return parsed;
  }

  /** Open the WS push channel. Returns a handle; events arrive via onEvent. */
  connectPush(handlers: PushHandlers): PushHandle {
    const options: { headers?: Record<string, string> } = {};
    if (this.token) {
      options.headers = { Authorization: `Bearer ${this.token}` };
    }
    const socket = this.socketFactory(this.pushUrl(), options);

    socket.on('open', () => handlers.onOpen?.());
    socket.on('message', (data: unknown) => {
      handlers.onEvent(parseEvent(data));
    });
    socket.on('error', (err: unknown) => handlers.onError?.(err));
    socket.on('close', () => handlers.onClose?.());

    return { close: () => socket.close() };
  }

  private pushUrl(): string {
    const u = new URL(this.baseUrl);
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    u.pathname = '/ws';
    u.search = '';
    return u.toString();
  }
}

function parseEvent(data: unknown): PushEvent {
  const text = typeof data === 'string' ? data : String(data);
  try {
    return JSON.parse(text) as PushEvent;
  } catch {
    return { type: 'raw', data: text };
  }
}
