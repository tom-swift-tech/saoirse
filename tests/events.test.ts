// Unit tests for EventBus: fan-out, unsubscribe, and listener isolation.
//
// The bus is the in-process join between the core (producer) and any channel
// (consumer). These tests assert the three properties the architecture relies on:
//   1. All active listeners receive every publish (fan-out).
//   2. Unsubscribe removes exactly that listener, others are unaffected.
//   3. A throwing listener is isolated — the publish call succeeds and remaining
//      listeners still fire (SYSTEM.md: loud failure, scoped).
import { describe, it, expect, vi } from 'vitest';
import { EventBus } from '../src/core/events.js';
import type { SaoirseEvent } from '../src/core/events.js';

const QUEUED: SaoirseEvent = { type: 'proposal.queued', id: 'p1', tier: 1 };
const RESOLVED: SaoirseEvent = { type: 'proposal.resolved', id: 'p1', action: 'approved' };

describe('EventBus', () => {
  describe('publish fan-out', () => {
    it('delivers the event to all subscribed listeners', () => {
      const bus = new EventBus();
      const a = vi.fn();
      const b = vi.fn();
      bus.subscribe(a);
      bus.subscribe(b);

      bus.publish(QUEUED);

      expect(a).toHaveBeenCalledTimes(1);
      expect(a).toHaveBeenCalledWith(QUEUED);
      expect(b).toHaveBeenCalledTimes(1);
      expect(b).toHaveBeenCalledWith(QUEUED);
    });

    it('delivers each event independently (two publishes = two calls each)', () => {
      const bus = new EventBus();
      const listener = vi.fn();
      bus.subscribe(listener);

      bus.publish(QUEUED);
      bus.publish(RESOLVED);

      expect(listener).toHaveBeenCalledTimes(2);
      expect(listener).toHaveBeenNthCalledWith(1, QUEUED);
      expect(listener).toHaveBeenNthCalledWith(2, RESOLVED);
    });

    it('is a no-op when there are no subscribers', () => {
      // Should not throw.
      const bus = new EventBus();
      expect(() => bus.publish(QUEUED)).not.toThrow();
    });
  });

  describe('unsubscribe', () => {
    it('stops delivering events to the unsubscribed listener', () => {
      const bus = new EventBus();
      const listener = vi.fn();
      const unsub = bus.subscribe(listener);

      bus.publish(QUEUED);
      unsub();
      bus.publish(RESOLVED);

      // Only the first publish reached the listener.
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(QUEUED);
    });

    it('does not affect other listeners when one unsubscribes', () => {
      const bus = new EventBus();
      const staying = vi.fn();
      const leaving = vi.fn();
      bus.subscribe(staying);
      const unsub = bus.subscribe(leaving);

      unsub();
      bus.publish(QUEUED);

      expect(leaving).not.toHaveBeenCalled();
      expect(staying).toHaveBeenCalledTimes(1);
    });

    it('is idempotent — calling the returned fn twice does not throw', () => {
      const bus = new EventBus();
      const listener = vi.fn();
      const unsub = bus.subscribe(listener);
      unsub();
      expect(() => unsub()).not.toThrow();
    });
  });

  describe('listener isolation', () => {
    it('a throwing listener is caught and the next listener still fires', () => {
      const bus = new EventBus();
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});

      const thrower = vi.fn(() => { throw new Error('bad consumer'); });
      const survivor = vi.fn();
      bus.subscribe(thrower);
      bus.subscribe(survivor);

      // publish must not throw even though a listener does.
      expect(() => bus.publish(QUEUED)).not.toThrow();

      expect(thrower).toHaveBeenCalledTimes(1);
      expect(survivor).toHaveBeenCalledTimes(1);
      // The error was reported, not swallowed silently.
      expect(err).toHaveBeenCalled();

      err.mockRestore();
    });
  });
});
