// =============================================================================
// nats.ts — East-west channel. A THIN transport over the core.
//
// Agents and services on the LAN fabric (the roster, n8n) reach Saoirse over
// NATS request/reply — never humans; human clients speak the north-facing
// HTTP/WS contract (docs/ARCHITECTURE.md, "Two planes"). The fabric is
// LAN/Tailscale-scoped, which is why there is no token here: reachability IS
// the boundary, exactly as for the rest of the east-west roster.
//
//   request  ${prefix}.message   {"text": "..."}
//   reply                        {"reply": "...", "recall": {...}, "tools": [...]}
//                                or {"error": "..."}
//
// The channel depends on a structural connection contract (the slice of
// nats.js it actually uses), not on the package — contracts not products, and
// tests inject a fake without a live server. index.ts supplies the real
// connection only when NATS_URL is configured; unset means no fabric, no
// import, no listener.
// =============================================================================

import type { SaoirseCore } from '../core/saoirse.js';

/** The slice of a NATS message this channel uses. */
export interface NatsMsgLike {
  data: Uint8Array;
  /** Publish a reply when the request carries a reply subject; false otherwise. */
  respond(data: Uint8Array): boolean;
}

/** The slice of a NATS subscription this channel uses (an async iterator of messages). */
export type NatsSubscriptionLike = AsyncIterable<NatsMsgLike>;

/** The slice of a NATS connection this channel uses. */
export interface NatsConnectionLike {
  subscribe(subject: string): NatsSubscriptionLike;
  drain(): Promise<void>;
}

export interface NatsDeps {
  core: SaoirseCore;
  connection: NatsConnectionLike;
  /** Subject prefix (NATS_PREFIX), e.g. "saoirse" -> "saoirse.message". */
  prefix: string;
}

export interface NatsChannel {
  subject: string;
  /** Resolves when the subscription loop has fully stopped. */
  done: Promise<void>;
  /** Graceful shutdown: drain in-flight requests, then stop. */
  close(): Promise<void>;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function attachNats(deps: NatsDeps): NatsChannel {
  const subject = `${deps.prefix}.message`;
  const subscription = deps.connection.subscribe(subject);

  const done = (async () => {
    for await (const msg of subscription) {
      try {
        const body = JSON.parse(decoder.decode(msg.data)) as {
          text?: unknown;
        };
        if (typeof body.text !== 'string' || body.text.trim() === '') {
          respond(msg, { error: 'request must include non-empty "text"' });
          continue;
        }
        const result = await deps.core.handleMessage(body.text);
        respond(msg, {
          reply: result.reply,
          recall: result.recall,
          tools: result.tools,
        });
      } catch (err) {
        // Same posture as the HTTP channel: surface on the daemon console,
        // return the message to the caller, keep serving.
        console.error('[saoirse] nats handler error:', err);
        respond(msg, { error: (err as Error).message });
      }
    }
  })();

  return {
    subject,
    done,
    close: async () => {
      await deps.connection.drain();
      await done;
    },
  };
}

function respond(msg: NatsMsgLike, body: unknown): void {
  // respond() is false when the requester sent no reply subject (fire-and-
  // forget publish) — nothing to answer, not an error.
  msg.respond(encoder.encode(JSON.stringify(body)));
}
