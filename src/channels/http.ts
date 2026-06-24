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
//   POST /engram/evaluate           { ref }  -> Tier-0 eval + proposal (TOKEN)
//   POST /engram/author             { description, test? } -> author   (TOKEN)
//   POST /proposals/:id/approve     -> tier 1: promote -> skills/;     (TOKEN — the gate)
//                                      tier 0 repin: re-pin package.json;
//                                      tier 0 author: 501 (publish deferred)
//   POST /proposals/:id/reject      -> discard the sandbox/clone        (TOKEN)
// =============================================================================

import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'http';
import type { SaoirseCore } from '../core/saoirse.js';
import {
  approveEngramProposal,
  approveProposal,
  readProposals,
  readProposalRouting,
  rejectEngramAuthor,
  rejectEngramProposal,
  rejectProposal,
} from '../proposals.js';
// EventSink is the ONLY events type HTTP depends on — publish only, no
// subscribe. The channel knows nothing about how events are delivered onward.
import type { EventSink } from '../core/events.js';
import type { JobStore, Schedule, JobAction } from '../core/jobs.js';

/** Per-skill grant summary emitted by /status — names and flags only, never values. */
export interface SkillPermissionAudit {
  name: string;
  /** Logical secret names declared by the skill (SAOIRSE_SECRET_<NAME> bare names). */
  secrets: string[];
  /** Egress host allowlist declared by the skill (Phase 1: declared, not yet enforced). */
  net: string[];
  /** Filesystem scopes granted to the skill beyond its own dir + temp. */
  fs: { read: string[]; write: string[] };
  /** Whether the skill may spawn child processes. */
  exec: boolean;
}

export interface StatusResponse {
  model: { name: string; endpoint: string; reachable: boolean };
  /** Committed skills loaded at daemon start (Tier-1 capabilities live this run). */
  skills: {
    count: number;
    names: string[];
    /** Grants audit: only skills with any non-default grant are included. */
    permissions: SkillPermissionAudit[];
  };
  version: string;
  /** Embedder health: mode + reachability. reachable is null when mode is not 'ollama'. */
  embeddings: { mode: string; reachable: boolean | null };
}

export interface HttpDeps {
  core: SaoirseCore;
  proposalsDir: string;
  /** Live committed-skills directory — written ONLY by approveProposal. */
  skillsDir: string;
  /** Sandbox root for accreted, un-promoted artifacts. */
  sandboxDir: string;
  /** package.json whose engram pin the Tier-0 gate rewrites (the ONLY writer). */
  packageJsonPath: string;
  /** Sandbox root for Tier-0 Engram candidate clones. */
  engramEvalSandbox: string;
  /** Sandbox root for Tier-0 authored-change clones. */
  engramAuthorSandbox: string;
  /** Privileged-action token (same as WS). Undefined => privileged routes fail closed. */
  token: string | undefined;
  /** Status provider (model name/endpoint/reachability + version). Built in index.ts. */
  status: () => Promise<StatusResponse>;
  /** Push-event sink for proposal state changes. Optional — omit in tests that
   *  don't care about events (all existing tests stay unchanged). */
  events?: EventSink;
  /** Persistent job store for the proactivity scheduler. Optional — omit in
   *  tests that don't exercise job routes. */
  jobStore?: JobStore;
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

      if (method === 'POST' && path === '/engram/evaluate') {
        if (!authorized(req, deps.token)) return unauthorized(res);
        if (!deps.core.canEvaluateEngram) {
          return send(res, 503, {
            error: 'engram evaluation is not configured',
          });
        }
        const body = (await readJsonBody(req)) as { ref?: unknown };
        if (typeof body.ref !== 'string' || body.ref.trim() === '') {
          return send(res, 400, { error: 'body must include non-empty "ref"' });
        }
        const outcome = await deps.core.handleEngramEvalRequest(body.ref.trim());
        return send(res, outcome.ok ? 200 : 422, outcome);
      }

      if (method === 'POST' && path === '/engram/author') {
        if (!authorized(req, deps.token)) return unauthorized(res);
        if (!deps.core.canAuthorEngram) {
          return send(res, 503, { error: 'engram authoring is not configured' });
        }
        const body = (await readJsonBody(req)) as {
          description?: unknown;
          test?: unknown;
        };
        if (typeof body.description !== 'string' || body.description.trim() === '') {
          return send(res, 400, {
            error: 'body must include non-empty "description"',
          });
        }
        const outcome = await deps.core.handleEngramAuthorRequest({
          description: body.description.trim(),
          test: typeof body.test === 'string' ? body.test : undefined,
        });
        return send(res, outcome.ok ? 200 : 422, outcome);
      }

      const promote = PROMOTE_RE.exec(path);
      if (method === 'POST' && promote) {
        if (!authorized(req, deps.token)) return unauthorized(res);
        const [, id, action] = promote;
        try {
          // One route, three gates: dispatch on tier and (for tier 0) kind.
          const { tier, kind } = await readProposalRouting(deps.proposalsDir, id);
          if (action === 'approve') {
            if (tier === 0 && kind === 'author') {
              // Authored changes are not re-pinnable (local SHA, no remote);
              // publishing is the deferred step. Fail loud, not silently.
              // NOTE: no event emitted here — nothing was resolved.
              return send(res, 501, {
                error:
                  'authored changes are not publishable yet — the publish step ' +
                  'is deferred. Reject to discard the local branch.',
              });
            }
            if (tier === 0) {
              const result = await approveEngramProposal(id, {
                proposalsDir: deps.proposalsDir,
                packageJsonPath: deps.packageJsonPath,
                evalSandboxRoot: deps.engramEvalSandbox,
              });
              // Tier-0 repin approved: emitted after the write succeeds.
              deps.events?.publish({ type: 'proposal.resolved', id, action: 'approved' });
              return send(res, 200, { repinned: result.candidateSha, ...result });
            }
            const result = await approveProposal(id, {
              proposalsDir: deps.proposalsDir,
              skillsDir: deps.skillsDir,
              sandboxRoot: deps.sandboxDir,
            });
            // Tier-1 tool approved: emitted after the write succeeds.
            deps.events?.publish({ type: 'proposal.resolved', id, action: 'approved' });
            return send(res, 200, { promoted: result.toolName, ...result });
          }
          if (tier === 0 && kind === 'author') {
            const result = await rejectEngramAuthor(id, {
              proposalsDir: deps.proposalsDir,
              authorSandboxRoot: deps.engramAuthorSandbox,
            });
            // Tier-0 author rejected: emitted after the discard succeeds.
            deps.events?.publish({ type: 'proposal.resolved', id, action: 'rejected' });
            return send(res, 200, { rejected: result.id });
          }
          if (tier === 0) {
            const result = await rejectEngramProposal(id, {
              proposalsDir: deps.proposalsDir,
              evalSandboxRoot: deps.engramEvalSandbox,
            });
            // Tier-0 repin rejected: emitted after the discard succeeds.
            deps.events?.publish({ type: 'proposal.resolved', id, action: 'rejected' });
            return send(res, 200, { rejected: result.id });
          }
          const result = await rejectProposal(id, {
            proposalsDir: deps.proposalsDir,
            sandboxRoot: deps.sandboxDir,
          });
          // Tier-1 tool rejected: emitted after the discard succeeds.
          deps.events?.publish({ type: 'proposal.resolved', id, action: 'rejected' });
          return send(res, 200, { rejected: result.id });
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            return send(res, 404, { error: `proposal not found: ${id}` });
          }
          throw err;
        }
      }

      // ---- proactivity: job CRUD (token-gated) ----------------------------

      if (deps.jobStore && method === 'POST' && path === '/jobs') {
        if (!authorized(req, deps.token)) return unauthorized(res);
        const body = (await readJsonBody(req)) as {
          schedule?: unknown;
          action?: unknown;
          enabled?: unknown;
        };
        // Validate schedule: {kind:'at',iso} or {kind:'cron',expr}
        const sched = body.schedule as Record<string, unknown> | undefined;
        if (!sched || typeof sched !== 'object') {
          return send(res, 400, { error: '"schedule" is required' });
        }
        if (sched.kind === 'at') {
          if (typeof sched.iso !== 'string' || isNaN(Date.parse(sched.iso as string))) {
            return send(res, 400, { error: 'schedule.iso must be a parseable ISO date string' });
          }
        } else if (sched.kind === 'cron') {
          if (typeof sched.expr !== 'string' || sched.expr.trim() === '') {
            return send(res, 400, { error: 'schedule.expr must be a non-empty string' });
          }
        } else {
          return send(res, 400, { error: 'schedule.kind must be "at" or "cron"' });
        }
        // Validate action: {type:'notify',text} or {type:'prompt',prompt}
        const act = body.action as Record<string, unknown> | undefined;
        if (!act || typeof act !== 'object') {
          return send(res, 400, { error: '"action" is required' });
        }
        if (act.type === 'notify') {
          if (typeof act.text !== 'string' || act.text.trim() === '') {
            return send(res, 400, { error: 'action.text must be a non-empty string' });
          }
        } else if (act.type === 'prompt') {
          if (typeof act.prompt !== 'string' || act.prompt.trim() === '') {
            return send(res, 400, { error: 'action.prompt must be a non-empty string' });
          }
        } else {
          return send(res, 400, { error: 'action.type must be "notify" or "prompt"' });
        }
        const { randomUUID } = await import('node:crypto');
        const job = {
          id: randomUUID().slice(0, 8),
          schedule: sched as Schedule,
          action: act as JobAction,
          enabled: body.enabled !== false,
          createdAt: new Date().toISOString(),
        };
        deps.jobStore.add(job);
        return send(res, 200, job);
      }

      if (deps.jobStore && method === 'GET' && path === '/jobs') {
        if (!authorized(req, deps.token)) return unauthorized(res);
        const jobs = deps.jobStore.list();
        return send(res, 200, { count: jobs.length, jobs });
      }

      const jobDeleteMatch = /^\/jobs\/([^/]+)$/.exec(path);
      if (deps.jobStore && method === 'DELETE' && jobDeleteMatch) {
        if (!authorized(req, deps.token)) return unauthorized(res);
        const [, id] = jobDeleteMatch;
        const removed = deps.jobStore.remove(id);
        if (!removed) return send(res, 404, { error: `job not found: ${id}` });
        return send(res, 200, { removed: id });
      }

      return send(res, 404, { error: 'not found' });
    } catch (err) {
      // Body too large: 413 before the generic 500 handler so the client gets
      // an actionable status code (and the OOM budget is never consumed).
      if (err instanceof BodyTooLargeError) {
        return send(res, 413, { error: err.message });
      }
      // Surface the failure on the headless daemon's own console — the response
      // body only carries the message, which no one is watching server-side.
      console.error('[saoirse] handler error:', err);
      return send(res, 500, { error: (err as Error).message });
    }
  };
}

/** Constant-time bearer-token check. Fails closed when no token is configured.
 *
 * We hash both sides with SHA-256 before comparing so that timingSafeEqual
 * always receives equal-length buffers (it throws on length mismatch, which
 * would leak the expected length via a thrown exception side-channel). The
 * hash step collapses all inputs to 32 bytes regardless of token length.
 */
function authorized(req: IncomingMessage, token: string | undefined): boolean {
  if (!token) return false;
  const auth = req.headers['authorization'];
  if (typeof auth !== 'string') return false;
  const expected = createHash('sha256').update(`Bearer ${token}`).digest();
  const actual = createHash('sha256').update(auth).digest();
  return timingSafeEqual(expected, actual);
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

/** Maximum request body size. /message is unauthenticated so an unbounded
 *  buffer is an OOM vector — reject anything beyond this before accumulating. */
const MAX_BODY_BYTES = 1 * 1024 * 1024; // 1 MiB

/** Body reader with a hard size cap. Throws a {status,body} sentinel on
 *  oversize so the router can respond 413 without buffering the full payload. */
async function readJsonBody(
  req: IncomingMessage,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.byteLength;
    if (total > MAX_BODY_BYTES) {
      // Drain the socket so the connection stays clean (HTTP keep-alive).
      req.resume();
      throw new BodyTooLargeError();
    }
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  return JSON.parse(raw);
}

/** Sentinel thrown by readJsonBody when the payload exceeds MAX_BODY_BYTES. */
class BodyTooLargeError extends Error {
  constructor() {
    super(`request body exceeds ${MAX_BODY_BYTES} bytes`);
    this.name = 'BodyTooLargeError';
  }
}
