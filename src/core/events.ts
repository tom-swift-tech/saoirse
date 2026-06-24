// =============================================================================
// events.ts — Transport-agnostic event bus (the core's "push" seam).
//
// The core PRODUCES events; channels CONSUME them. Mirrors the rest of the
// architecture: the core depends only on the EventSink interface (it can
// publish, it knows nothing about WebSockets), and a channel depends only on
// EventSource (it can subscribe, it knows nothing about who produces). EventBus
// is the in-process implementation that joins the two — created once in
// index.ts, handed to the core as a sink and to the WS channel as a source.
//
// This is what turns the WS plane from a skeleton (hello/heartbeat/echo) into a
// real push channel: a state change in the core (a proposal queued or resolved)
// becomes an event the dashboard sees without polling.
//
// publish() never throws: a misbehaving listener is logged and isolated, never
// allowed to break the producer (loud failure, scoped — SYSTEM.md).
// =============================================================================

/** Every push event the core can emit. Discriminated on `type`. */
export type SaoirseEvent =
  | { type: 'proposal.queued'; id: string; tier: 0 | 1; kind?: string }
  | { type: 'proposal.resolved'; id: string; action: 'approved' | 'rejected' };

export type EventListener = (event: SaoirseEvent) => void;

/** The producer side: the core depends on this, never on a transport. */
export interface EventSink {
  publish(event: SaoirseEvent): void;
}

/** The consumer side: a channel subscribes; the returned fn unsubscribes. */
export interface EventSource {
  subscribe(listener: EventListener): () => void;
}

/** In-process fan-out bus. Implements both sides; joins core to channels. */
export class EventBus implements EventSink, EventSource {
  private readonly listeners = new Set<EventListener>();

  publish(event: SaoirseEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        // A bad consumer must never break the producer — isolate and report.
        console.error('[saoirse] event listener error:', err);
      }
    }
  }

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
