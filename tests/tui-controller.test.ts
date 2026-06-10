// The TUI dashboard logic, headless: a mocked client, no terminal. Asserts the
// conversation/recall/status/proposals projections and that privileged actions
// carry the bearer token (fail-closed without). Plus the client-boundary guard.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { DashboardController } from '../src/client/tui-controller.js';
import { SaoirseClient, type FetchLike } from '../src/client/client.js';

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

function makeClient(fetchImpl: FetchLike, token?: string) {
  return new SaoirseClient({
    baseUrl: 'http://localhost:8787',
    token,
    fetchImpl,
  });
}

function controller(
  fetchImpl: FetchLike,
  tokenPresent = false,
  token?: string,
) {
  return new DashboardController(makeClient(fetchImpl, token), {
    baseUrl: 'http://localhost:8787',
    tokenPresent,
  });
}

describe('conversation + recall', () => {
  it('renders the reply and the recall count from the extended response', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ reply: 'all quiet', recall: { count: 3 } }),
      ) as FetchLike;
    const ctrl = controller(fetchImpl);

    await ctrl.send("what's new");

    const lines = ctrl.conversationLines();
    expect(lines.some((l) => l.includes("what's new"))).toBe(true);
    expect(lines.some((l) => l.includes('all quiet'))).toBe(true);
    expect(ctrl.state.lastRecallCount).toBe(3);
    expect(ctrl.memoryPane()).toContain('3 recalled');
  });

  it('shows a friendly line (no stack) when the daemon is unreachable', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValue(new TypeError('fetch failed')) as FetchLike;
    const ctrl = controller(fetchImpl);
    await ctrl.send('hi');
    expect(
      ctrl.conversationLines().some((l) => l.includes('not reachable')),
    ).toBe(true);
    expect(ctrl.state.connected).toBe(false);
  });
});

describe('status pane', () => {
  it('parses GET /status and renders the model; reachable=false => offline', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        model: { name: 'qwen3.6', endpoint: 'http://h/v1', reachable: false },
        version: '0.1.0',
      }),
    ) as FetchLike;
    const ctrl = controller(fetchImpl);

    await ctrl.refreshStatus();

    expect(ctrl.state.connected).toBe(true); // the daemon itself answered
    expect(ctrl.modelPane()).toContain('qwen3.6');
    expect(ctrl.modelPane()).toContain('offline');
  });

  it('marks disconnected when the daemon is unreachable', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValue(new TypeError('fetch failed')) as FetchLike;
    const ctrl = controller(fetchImpl);
    await ctrl.refreshStatus();
    expect(ctrl.state.connected).toBe(false);
    expect(ctrl.connectionLine()).toContain('disconnected');
  });
});

describe('proposals pane + privileged actions', () => {
  it('lists pending proposals from GET /proposals', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ count: 1, proposals: [{ name: 'weather-x.json' }] }),
      ) as FetchLike;
    const ctrl = controller(fetchImpl);
    await ctrl.refreshProposals();
    expect(ctrl.proposalsPane()).toContain('Proposals: 1 pending');
    expect(ctrl.proposalsPane().some((l) => l.includes('weather-x.json'))).toBe(
      true,
    );
  });

  it('approve sends the bearer token', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ promoted: 'weather' }))
      .mockResolvedValueOnce(
        jsonResponse({ count: 0, proposals: [] }),
      ) as FetchLike;
    const ctrl = controller(fetchImpl, true, 'tok');

    await ctrl.approve('weather-x');

    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(url).toContain('/proposals/weather-x/approve');
    expect(init.headers.authorization).toBe('Bearer tok');
    expect(
      ctrl.conversationLines().some((l) => l.includes('approved weather-x')),
    ).toBe(true);
  });

  it('approve is fail-closed without a token — nothing is sent', async () => {
    const fetchImpl = vi.fn() as FetchLike;
    const ctrl = controller(fetchImpl, false);
    await ctrl.approve('weather-x');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(
      ctrl.conversationLines().some((l) => l.includes('fail-closed')),
    ).toBe(true);
  });

  it('reject sends the bearer token', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ rejected: 'weather-x' }))
      .mockResolvedValueOnce(
        jsonResponse({ count: 0, proposals: [] }),
      ) as FetchLike;
    const ctrl = controller(fetchImpl, true, 'tok');
    await ctrl.reject('weather-x');
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(url).toContain('/proposals/weather-x/reject');
    expect(init.headers.authorization).toBe('Bearer tok');
  });
});

describe('push log', () => {
  it('records pushed events for the status area', () => {
    const ctrl = controller(vi.fn() as FetchLike);
    ctrl.pushEvent({ type: 'heartbeat', ts: 123 });
    expect(ctrl.pushLine()).toContain('heartbeat');
  });
});

describe('TUI client boundary', () => {
  it('imports only the wire client + pi-tui + node builtins', () => {
    const clientDir = join(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      'src',
      'client',
    );
    const forbidden =
      /from\s+['"][^'"]*(core\/|\/memory|engram|gateway|channels\/|config)['"]/;
    for (const file of ['tui.ts', 'tui-controller.ts']) {
      const src = readFileSync(join(clientDir, file), 'utf8');
      expect(src, `${file} must not import core internals`).not.toMatch(
        forbidden,
      );
    }
  });
});
