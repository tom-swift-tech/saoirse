// =============================================================================
// notifier.test.ts — unit tests for NtfyNotifier and NullNotifier.
//
// NtfyNotifier tests spin up a real node:http server on a random port so the
// implementation exercises actual fetch() paths. Error conditions (non-2xx,
// unreachable URL) verify the best-effort contract: notify() must always resolve
// without throwing.
// =============================================================================

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { NtfyNotifier, NullNotifier } from '../src/core/notifier.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function startServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ server: Server; url: string }> {
  return new Promise((resolve, reject) => {
    const server = createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('unexpected address'));
        return;
      }
      resolve({ server, url: `http://127.0.0.1:${addr.port}/topic` });
    });
    server.on('error', reject);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => resolve(body));
  });
}

// ---------------------------------------------------------------------------
// NtfyNotifier
// ---------------------------------------------------------------------------

describe('NtfyNotifier', () => {
  describe('successful POST', () => {
    let server: Server;
    let url: string;

    // Captured request data from the handler.
    let capturedMethod: string | undefined;
    let capturedBody: string | undefined;
    let capturedTitleHeader: string | undefined;

    beforeAll(async () => {
      ({ server, url } = await startServer(async (req, res) => {
        capturedMethod = req.method;
        capturedTitleHeader = req.headers['title'] as string | undefined;
        capturedBody = await readBody(req);
        res.writeHead(200);
        res.end();
      }));
    });

    afterAll(() => closeServer(server));

    it('POSTs the message as the request body', async () => {
      const notifier = new NtfyNotifier({ url });
      await notifier.notify({ message: 'hello world' });
      expect(capturedMethod).toBe('POST');
      expect(capturedBody).toBe('hello world');
    });

    it('sets the Title header when title is provided', async () => {
      const notifier = new NtfyNotifier({ url });
      await notifier.notify({ title: 'My Title', message: 'with title' });
      expect(capturedTitleHeader).toBe('My Title');
      expect(capturedBody).toBe('with title');
    });

    it('omits the Title header when title is absent', async () => {
      capturedTitleHeader = undefined;
      const notifier = new NtfyNotifier({ url });
      await notifier.notify({ message: 'no title' });
      expect(capturedTitleHeader).toBeUndefined();
    });
  });

  describe('non-2xx response — best-effort contract', () => {
    let server: Server;
    let url: string;

    beforeAll(async () => {
      ({ server, url } = await startServer((_req, res) => {
        res.writeHead(500);
        res.end('Internal Server Error');
      }));
    });

    afterAll(() => closeServer(server));

    it('resolves without throwing on a non-2xx response', async () => {
      const notifier = new NtfyNotifier({ url });
      // Must resolve — no assertion needed beyond "not thrown".
      await expect(notifier.notify({ message: 'oops' })).resolves.toBeUndefined();
    });
  });

  describe('unreachable URL — best-effort contract', () => {
    it('resolves without throwing when the server is unreachable', async () => {
      // Port 1 is almost certainly unreachable.
      const notifier = new NtfyNotifier({
        url: 'http://127.0.0.1:1/topic',
        timeoutMs: 500,
      });
      await expect(notifier.notify({ message: 'lost' })).resolves.toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// NullNotifier
// ---------------------------------------------------------------------------

describe('NullNotifier', () => {
  it('resolves without throwing', async () => {
    const notifier = new NullNotifier();
    await expect(notifier.notify({ message: 'ping' })).resolves.toBeUndefined();
  });

  it('resolves without throwing when title is given', async () => {
    const notifier = new NullNotifier();
    await expect(notifier.notify({ title: 'T', message: 'ping' })).resolves.toBeUndefined();
  });

  it('logs the message to the console', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const notifier = new NullNotifier();
      await notifier.notify({ message: 'visible' });
      expect(spy).toHaveBeenCalledWith(
        expect.stringContaining('(no outbound configured)'),
      );
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('visible'));
    } finally {
      spy.mockRestore();
    }
  });

  it('includes the title in the log output', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const notifier = new NullNotifier();
      await notifier.notify({ title: 'Heads up', message: 'something happened' });
      const logged = spy.mock.calls[0]?.[0] as string;
      expect(logged).toContain('Heads up');
      expect(logged).toContain('something happened');
    } finally {
      spy.mockRestore();
    }
  });
});
