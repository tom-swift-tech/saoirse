// =============================================================================
// ws.ts — North-facing WebSocket channel. A THIN transport over the core.
//
// The core pushes (ambient/streaming). Auth token required on connect; the
// listener is Tailscale-scoped. For the skeleton a connected client just
// receives a hello + heartbeat — proof the push path exists. Real dashboard
// events come later.
//
// Auth fails closed: if no token is configured, every connection is rejected.
// Token may be supplied via ?token=, Authorization: Bearer, or the
// Sec-WebSocket-Protocol header.
// =============================================================================

import type { IncomingMessage, Server } from 'http';
import type { Duplex } from 'stream';
import { WebSocketServer, type WebSocket } from 'ws';

const WS_PATH = '/ws';
const HEARTBEAT_MS = 30_000;

export interface WsDeps {
  token: string | undefined;
}

export function attachWebSocket(server: Server, deps: WsDeps): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = (req.url ?? '/').split('?')[0];
    if (path !== WS_PATH) {
      reject(socket, 404, 'Not Found');
      return;
    }
    if (!deps.token || extractToken(req) !== deps.token) {
      reject(socket, 401, 'Unauthorized');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (socket: WebSocket) => {
    socket.send(
      JSON.stringify({ type: 'hello', message: 'saoirse push channel open' }),
    );

    const heartbeat = setInterval(() => {
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify({ type: 'heartbeat', ts: Date.now() }));
      }
    }, HEARTBEAT_MS);

    // Echo, to prove the path is bidirectional on the skeleton.
    socket.on('message', (data) => {
      socket.send(JSON.stringify({ type: 'echo', data: data.toString() }));
    });

    socket.on('close', () => clearInterval(heartbeat));
  });

  return wss;
}

function reject(socket: Duplex, code: number, reason: string): void {
  socket.write(
    `HTTP/1.1 ${code} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
  socket.destroy();
}

function extractToken(req: IncomingMessage): string | undefined {
  const auth = req.headers['authorization'];
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    return auth.slice('Bearer '.length).trim();
  }
  const proto = req.headers['sec-websocket-protocol'];
  if (typeof proto === 'string' && proto.trim()) {
    return proto.split(',')[0].trim();
  }
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    return url.searchParams.get('token') ?? undefined;
  } catch {
    return undefined;
  }
}
