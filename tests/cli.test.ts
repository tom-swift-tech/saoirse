// The CLI is a thin client over the daemon's wire contract — tested with a
// mocked fetch and a fake socket factory, no live daemon. These tests also
// guard the architecture's central boundary: the client imports nothing from
// the core.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { EventEmitter } from 'events';
import { main, reportError, type CliDeps } from '../src/client/cli.js';
import {
  SaoirseClient,
  DaemonUnreachableError,
  type FetchLike,
  type SocketLike,
} from '../src/client/client.js';

// --- helpers ---------------------------------------------------------------

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

interface Captured {
  out: string[];
  err: string[];
  exitCode: number | null;
}

function makeDeps(
  overrides: Partial<CliDeps> & { captured: Captured; client?: SaoirseClient },
): CliDeps {
  const { captured } = overrides;
  return {
    env: overrides.env ?? {},
    stdout: (line) => captured.out.push(line),
    stderr: (line) => captured.err.push(line),
    exit: (code) => {
      captured.exitCode = code;
    },
    readStdin: overrides.readStdin ?? (async () => null),
    createClient: overrides.createClient ?? (() => overrides.client!),
    startRepl: overrides.startRepl ?? (async () => {}),
  };
}

// --- one-shot --------------------------------------------------------------

describe('CLI one-shot', () => {
  it('posts to /message and prints the reply', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ reply: 'all quiet' })) as FetchLike;
    const client = new SaoirseClient({
      baseUrl: 'http://localhost:8787',
      fetchImpl,
    });
    const captured: Captured = { out: [], err: [], exitCode: null };

    await main(["what's new"], makeDeps({ captured, client }));

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(url).toBe('http://localhost:8787/message');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ text: "what's new" });
    expect(captured.out).toEqual(['all quiet']);
    expect(captured.exitCode).toBeNull(); // success path doesn't force exit
  });

  it('reads the message from piped stdin when no args are given', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ reply: 'from pipe' })) as FetchLike;
    const client = new SaoirseClient({
      baseUrl: 'http://localhost:8787',
      fetchImpl,
    });
    const captured: Captured = { out: [], err: [], exitCode: null };

    await main(
      [],
      makeDeps({
        captured,
        client,
        readStdin: async () => 'piped question\n',
      }),
    );

    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(JSON.parse(init.body)).toEqual({ text: 'piped question' });
    expect(captured.out).toEqual(['from pipe']);
  });

  it('--json prints the raw daemon response', async () => {
    const payload = { reply: 'hello', sessionId: 'wm-1' };
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse(payload)) as FetchLike;
    const client = new SaoirseClient({
      baseUrl: 'http://localhost:8787',
      fetchImpl,
    });
    const captured: Captured = { out: [], err: [], exitCode: null };

    await main(['--json', 'hi'], makeDeps({ captured, client }));

    expect(captured.out).toHaveLength(1);
    expect(JSON.parse(captured.out[0])).toEqual(payload);
  });

  it('prints a friendly message and exits non-zero when the daemon is unreachable', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(
      Object.assign(new TypeError('fetch failed'), {
        cause: { code: 'ECONNREFUSED' },
      }),
    ) as FetchLike;
    const client = new SaoirseClient({
      baseUrl: 'http://saoirse.example:8787',
      fetchImpl,
    });
    const captured: Captured = { out: [], err: [], exitCode: null };

    await main(
      ['hi'],
      makeDeps({
        captured,
        client,
        env: { SAOIRSE_URL: 'http://saoirse.example:8787' },
      }),
    );

    expect(captured.exitCode).toBe(1);
    expect(captured.err).toHaveLength(1);
    expect(captured.err[0]).toContain('not reachable');
    expect(captured.err[0]).toContain('http://saoirse.example:8787');
    // no stack trace dumped
    expect(captured.err[0]).not.toMatch(/at .*\(/);
  });
});

// --- WS push ---------------------------------------------------------------

class FakeSocket extends EventEmitter implements SocketLike {
  closed = false;
  constructor(
    readonly url: string,
    readonly options: { headers?: Record<string, string> },
  ) {
    super();
  }
  close(): void {
    this.closed = true;
  }
}

describe('CLI push channel', () => {
  it('connects with the token and surfaces pushed events', async () => {
    const sockets: FakeSocket[] = [];
    const client = new SaoirseClient({
      baseUrl: 'http://localhost:8787',
      token: 'secret-token',
      socketFactory: (url, options) => {
        const s = new FakeSocket(url, options);
        sockets.push(s);
        return s;
      },
    });

    const events: Array<{ type: string }> = [];
    const handle = client.connectPush({ onEvent: (e) => events.push(e) });

    expect(sockets).toHaveLength(1);
    // dials the WS path with the bearer token
    expect(sockets[0].url).toBe('ws://localhost:8787/ws');
    expect(sockets[0].options.headers).toEqual({
      Authorization: 'Bearer secret-token',
    });

    // a pushed heartbeat arrives and is parsed
    sockets[0].emit('message', JSON.stringify({ type: 'heartbeat', ts: 123 }));
    expect(events).toEqual([{ type: 'heartbeat', ts: 123 }]);

    handle.close();
    expect(sockets[0].closed).toBe(true);
  });
});

// --- error reporting -------------------------------------------------------

describe('reportError', () => {
  it('renders the unreachable message without a stack trace', () => {
    const lines: string[] = [];
    reportError(new DaemonUnreachableError('http://x:1'), 'http://x:1', (l) =>
      lines.push(l),
    );
    expect(lines).toEqual([
      'Saoirse core not reachable at http://x:1 — is the daemon running?',
    ]);
  });
});

// --- governance subcommands -------------------------------------------------

describe('CLI governance subcommands', () => {
  function clientWith(body: unknown) {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse(body)) as FetchLike;
    const client = new SaoirseClient({
      baseUrl: 'http://localhost:8787',
      token: 'tok',
      fetchImpl,
    });
    return { client, fetchImpl };
  }

  it('approve posts to the approve route WITH the bearer token', async () => {
    const { client, fetchImpl } = clientWith({ promoted: 'weather' });
    const captured: Captured = { out: [], err: [], exitCode: null };
    await main(['approve', 'weather-faux'], makeDeps({ captured, client }));
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(url).toBe('http://localhost:8787/proposals/weather-faux/approve');
    expect(init.method).toBe('POST');
    expect(init.headers.authorization).toBe('Bearer tok');
    expect(captured.out[0]).toContain('approved');
  });

  it('build posts a {name, description} spec to /build', async () => {
    const { client, fetchImpl } = clientWith({
      proposalId: 'weather-x',
      status: 'pending',
    });
    const captured: Captured = { out: [], err: [], exitCode: null };
    await main(
      ['build', 'weather', 'fetch', 'the', 'weather'],
      makeDeps({ captured, client }),
    );
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(url).toBe('http://localhost:8787/build');
    expect(JSON.parse(init.body)).toEqual({
      name: 'weather',
      description: 'fetch the weather',
    });
    expect(captured.out[0]).toContain('weather-x');
  });

  it('proposals prints the pending queue', async () => {
    const { client } = clientWith({
      count: 1,
      proposals: [{ name: 'weather-x.json' }],
    });
    const captured: Captured = { out: [], err: [], exitCode: null };
    await main(['proposals'], makeDeps({ captured, client }));
    expect(captured.out[0]).toContain('1 proposal');
  });
});

// --- boundary guard --------------------------------------------------------

describe('client boundary', () => {
  it('imports nothing from the core (the architecture boundary)', () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    const clientDir = join(dir, '..', 'src', 'client');
    const forbidden =
      /from\s+['"][^'"]*(core\/|\/memory|engram|gateway|channels\/|config)['"]/;
    for (const file of ['client.ts', 'cli.ts']) {
      const src = readFileSync(join(clientDir, file), 'utf8');
      expect(src, `${file} must not import core internals`).not.toMatch(
        forbidden,
      );
    }
  });
});
