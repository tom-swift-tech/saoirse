// WS auth: the push channel fails closed. Rejects connects without a valid
// token, accepts with one and immediately pushes a hello event.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import WebSocket from 'ws';
import { attachWebSocket } from '../src/channels/ws.js';

const TOKEN = 'test-secret-token';

let server: http.Server;
let port: number;

beforeAll(async () => {
  server = http.createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  attachWebSocket(server, { token: TOKEN });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function attempt(query: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws${query}`);
    ws.on('open', () => resolve(ws));
    ws.on('error', (err) => reject(err));
    ws.on('unexpected-response', (_req, res) =>
      reject(new Error(`unexpected ${res.statusCode}`)),
    );
  });
}

describe('WS auth', () => {
  it('rejects a connection with no token', async () => {
    await expect(attempt('')).rejects.toThrow();
  });

  it('rejects a connection with a wrong token (query string)', async () => {
    await expect(attempt('?token=wrong')).rejects.toThrow();
  });

  it('rejects a connection with a wrong token (Authorization header)', async () => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`, {
      headers: { Authorization: 'Bearer wrong-token' },
    });
    await expect(
      new Promise<void>((resolve, reject) => {
        ws.on('open', () => resolve());
        ws.on('error', (err) => reject(err));
        ws.on('unexpected-response', (_req, res) =>
          reject(new Error(`unexpected ${res.statusCode}`)),
        );
      }),
    ).rejects.toThrow();
  });

  it('accepts a connection with the valid token (query string) and pushes hello', async () => {
    // Query-string path is preserved for test-suite and tooling compatibility;
    // prefer Authorization: Bearer in production clients (see ws.ts comment).
    const ws = new WebSocket(`ws://localhost:${port}/ws?token=${TOKEN}`);
    const event = await new Promise<{ type: string }>((resolve, reject) => {
      ws.on('message', (data) => resolve(JSON.parse(data.toString())));
      ws.on('error', reject);
      ws.on('unexpected-response', (_req, res) =>
        reject(new Error(`unexpected ${res.statusCode}`)),
      );
    });
    expect(event.type).toBe('hello');
    ws.close();
  });

  it('accepts a connection with the valid token (Authorization header) and pushes hello', async () => {
    // Preferred auth path: header does not appear in server logs or proxy URLs.
    const ws = new WebSocket(`ws://localhost:${port}/ws`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const event = await new Promise<{ type: string }>((resolve, reject) => {
      ws.on('message', (data) => resolve(JSON.parse(data.toString())));
      ws.on('error', reject);
      ws.on('unexpected-response', (_req, res) =>
        reject(new Error(`unexpected ${res.statusCode}`)),
      );
    });
    expect(event.type).toBe('hello');
    ws.close();
  });
});
