// WS event broadcast: authenticated clients receive published SaoirseEvents as
// JSON. Verifies fan-out to multiple clients and no crash when a client has
// already disconnected before the event fires.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import WebSocket from 'ws';
import { attachWebSocket } from '../src/channels/ws.js';
import { EventBus } from '../src/core/events.js';
import type { SaoirseEvent } from '../src/core/events.js';

const TOKEN = 'test-secret-token';

let server: http.Server;
let bus: EventBus;
let port: number;

beforeAll(async () => {
  bus = new EventBus();
  server = http.createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  attachWebSocket(server, { token: TOKEN, events: bus });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/**
 * Connect, skip the hello frame, then return the ws and a promise that
 * resolves with the NEXT message after hello. Listeners are wired before
 * the socket opens so no frame is missed.
 */
function connectAndSkipHello(): Promise<{ ws: WebSocket; next: Promise<unknown> }> {
  return new Promise((outerResolve, outerReject) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws?token=${TOKEN}`);
    let helloSkipped = false;
    // nextP is settled the first time a post-hello message arrives.
    let nextResolve: (v: unknown) => void;
    let nextReject: (e: unknown) => void;
    const nextP = new Promise<unknown>((res, rej) => {
      nextResolve = res;
      nextReject = rej;
    });

    ws.on('error', (err) => {
      outerReject(err);
      nextReject(err);
    });
    ws.on('unexpected-response', (_req, res) => {
      const err = new Error(`unexpected ${res.statusCode}`);
      outerReject(err);
      nextReject(err);
    });

    ws.on('message', (data) => {
      if (!helloSkipped) {
        helloSkipped = true;
        // hello received — hand back control; further messages resolve nextP.
        outerResolve({ ws, next: nextP });
        return;
      }
      nextResolve(JSON.parse(data.toString()));
    });
  });
}

describe('WS event broadcast', () => {
  it('delivers a published event to a single authenticated client', async () => {
    const { ws, next } = await connectAndSkipHello();

    const event: SaoirseEvent = {
      type: 'proposal.queued',
      id: 'abc-1',
      tier: 1,
      kind: 'tool-call',
    };
    bus.publish(event);

    const received = await next;
    expect(received).toEqual(event);
    ws.close();
  });

  it('delivers a published event to multiple connected clients', async () => {
    const [a, b] = await Promise.all([
      connectAndSkipHello(),
      connectAndSkipHello(),
    ]);

    const event: SaoirseEvent = { type: 'proposal.resolved', id: 'abc-2', action: 'approved' };
    bus.publish(event);

    const [recvA, recvB] = await Promise.all([a.next, b.next]);
    expect(recvA).toEqual(event);
    expect(recvB).toEqual(event);

    a.ws.close();
    b.ws.close();
  });

  it('does not crash when one client has disconnected before the event fires', async () => {
    const { ws: live, next } = await connectAndSkipHello();
    const { ws: dead } = await connectAndSkipHello();

    // Close the dead client and let the server notice before publishing.
    await new Promise<void>((resolve) => {
      dead.on('close', resolve);
      dead.close();
    });
    // Small yield so the server-side readyState transitions to CLOSED.
    await new Promise((r) => setTimeout(r, 30));

    bus.publish({ type: 'proposal.queued', id: 'abc-3', tier: 0 });

    const received = await next;
    expect((received as SaoirseEvent).type).toBe('proposal.queued');
    live.close();
  });
});
