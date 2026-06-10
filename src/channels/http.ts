// =============================================================================
// http.ts — North-facing HTTP channel. A THIN transport over the core.
//
// The client initiates and waits (turn-based). All logic lives in the core /
// proposals module; this only parses, dispatches, serializes, and enforces the
// token on privileged routes.
//
//   POST /message                   { text }  -> { reply, recall, tools } (open)
//   GET  /status                              -> { model, skills, version } (open)
//   GET  /proposals                           -> { count, proposals } (open, read-only)
//   GET  /health                              -> { status }           (open)
//   POST /build                     { name, description, test? }      (TOKEN)
//   POST /proposals/:id/approve     -> promote sandbox -> skills/      (TOKEN — the gate)
//   POST /proposals/:id/reject      -> discard sandbox artifact        (TOKEN)
// =============================================================================

import type { IncomingMessage, ServerResponse } from 'http';
import type { SaoirseCore } from '../core/saoirse.js';
import {
  approveProposal,
  readProposals,
  rejectProposal,
} from '../proposals.js';

export interface StatusResponse {
  model: { name: string; endpoint: string; reachable: boolean };
  /** Committed skills loaded at daemon start (Tier-1 capabilities live this run). */
  skills: { count: number; names: string[] };
  version: string;
}

export interface HttpDeps {
  core: SaoirseCore;
  proposalsDir: string;
  /** Live committed-skills directory — written ONLY by approveProposal. */
  skillsDir: string;
  /** Sandbox root for accreted, un-promoted artifacts. */
  sandboxDir: string;
  /** Privileged-action token (same as WS). Undefined => privileged routes fail closed. */
  token: string | undefined;
  /** Status provider (model name/endpoint/reachability + version). Built in index.ts. */
  status: () => Promise<StatusResponse>;
}

export type Router = (
  req: IncomingMessage,
  res: ServerResponse,
) => Promise<void>;

const PROMOTE_RE = /^\/proposals\/([^/]+)\/(approve|reject)$/;

export function createRouter(deps: HttpDeps): Router {
  return async function router(req, res): Promise<void> {
    try {
      const path = (req.url ?? '/').split('?')[0];
      const method = req.method ?? 'GET';

      if (method === 'POST' && path === '/message') {
        const body = (await readJsonBody(req)) as { text?: unknown };
        if (typeof body.text !== 'string' || body.text.trim() === '') {
          return send(res, 400, {
            error: 'body must include non-empty "text"',
          });
        }
        const result = await deps.core.handleMessage(body.text);
        // Additive: `recall`/`tools` are new; `reply` is unchanged for existing clients.
        return send(res, 200, {
          reply: result.reply,
          recall: result.recall,
          tools: result.tools,
        });
      }

      if (method === 'GET' && path === '/status') {
        return send(res, 200, await deps.status());
      }

      if (method === 'GET' && path === '/proposals') {
        return send(res, 200, await readProposals(deps.proposalsDir));
      }

      if (method === 'GET' && path === '/health') {
        return send(res, 200, { status: 'ok' });
      }

      // ---- privileged routes (token-gated) ---------------------------------

      if (method === 'POST' && path === '/build') {
        if (!authorized(req, deps.token)) return unauthorized(res);
        if (!deps.core.canBuildTools) {
          return send(res, 503, {
            error: 'tool building is not configured (PI_COMMAND unset)',
          });
        }
        const body = (await readJsonBody(req)) as {
          name?: unknown;
          description?: unknown;
          test?: unknown;
        };
        if (
          typeof body.name !== 'string' ||
          typeof body.description !== 'string'
        ) {
          return send(res, 400, {
            error: 'body must include string "name" and "description"',
          });
        }
        const outcome = await deps.core.handleBuildRequest({
          name: body.name,
          description: body.description,
          test: typeof body.test === 'string' ? body.test : undefined,
        });
        return send(res, 200, outcome);
      }

      const promote = PROMOTE_RE.exec(path);
      if (method === 'POST' && promote) {
        if (!authorized(req, deps.token)) return unauthorized(res);
        const [, id, action] = promote;
        try {
          if (action === 'approve') {
            const result = await approveProposal(id, {
              proposalsDir: deps.proposalsDir,
              skillsDir: deps.skillsDir,
              sandboxRoot: deps.sandboxDir,
            });
            return send(res, 200, { promoted: result.toolName, ...result });
          }
          const result = await rejectProposal(id, {
            proposalsDir: deps.proposalsDir,
            sandboxRoot: deps.sandboxDir,
          });
          return send(res, 200, { rejected: result.id });
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            return send(res, 404, { error: `proposal not found: ${id}` });
          }
          throw err;
        }
      }

      return send(res, 404, { error: 'not found' });
    } catch (err) {
      // Surface the failure on the headless daemon's own console — the response
      // body only carries the message, which no one is watching server-side.
      console.error('[saoirse] handler error:', err);
      return send(res, 500, { error: (err as Error).message });
    }
  };
}

/** Bearer-token check. Fails closed when no token is configured. */
function authorized(req: IncomingMessage, token: string | undefined): boolean {
  if (!token) return false;
  const auth = req.headers['authorization'];
  return typeof auth === 'string' && auth === `Bearer ${token}`;
}

function unauthorized(res: ServerResponse): void {
  send(res, 401, {
    error: 'unauthorized — privileged action requires the token',
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  return JSON.parse(raw);
}
