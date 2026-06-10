// The east-west NATS channel: a thin request/reply transport over the core,
// proven against a fake connection (the structural NatsConnectionLike slice) —
// no live server, mirroring how every other channel is tested.
import { describe, it, expect } from 'vitest';
import { attachNats, type NatsMsgLike } from '../src/channels/nats.js';
import { SaoirseCore } from '../src/core/saoirse.js';
import type { Memory, RecalledContext, Exchange } from '../src/core/memory.js';
import type { ModelGateway } from '../src/core/model-gateway.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

class FakeMemory implements Memory {
  async recall(): Promise<RecalledContext> {
    return { text: '', sessionId: 'wm-nats', reason: 'new', count: 0 };
  }
  async retain(_exchange: Exchange): Promise<void> {}
  close(): void {}
}

const gateway: ModelGateway = {
  complete: async (prompt: string) => `echo: ${prompt}`,
};

class FakeMsg implements NatsMsgLike {
  responses: unknown[] = [];
  constructor(readonly data: Uint8Array) {}
  respond(data: Uint8Array): boolean {
    this.responses.push(JSON.parse(decoder.decode(data)));
    return true;
  }
}

/** A fake connection: one subscription fed from an array of requests. */
function fakeConnection(msgs: FakeMsg[]) {
  const subjects: string[] = [];
  let drained = false;
  return {
    subjects,
    isDrained: () => drained,
    subscribe(subject: string) {
      subjects.push(subject);
      return (async function* () {
        yield* msgs;
      })();
    },
    drain: async () => {
      drained = true;
    },
  };
}

function request(body: unknown): FakeMsg {
  return new FakeMsg(encoder.encode(JSON.stringify(body)));
}

describe('NATS east-west channel', () => {
  it('serves request/reply on <prefix>.message over the core', async () => {
    const msg = request({ text: 'what is new' });
    const connection = fakeConnection([msg]);
    const core = new SaoirseCore(new FakeMemory(), gateway);

    const channel = attachNats({ core, connection, prefix: 'saoirse' });
    await channel.done;

    expect(connection.subjects).toEqual(['saoirse.message']);
    expect(msg.responses).toEqual([
      {
        reply: 'echo: what is new',
        recall: { count: 0 },
        tools: [],
      },
    ]);
  });

  it('answers a malformed request with an error, and keeps serving', async () => {
    const bad = new FakeMsg(encoder.encode('not json'));
    const empty = request({ text: '   ' });
    const good = request({ text: 'hi' });
    const connection = fakeConnection([bad, empty, good]);
    const core = new SaoirseCore(new FakeMemory(), gateway);

    const channel = attachNats({ core, connection, prefix: 'saoirse' });
    await channel.done;

    expect(bad.responses).toHaveLength(1);
    expect((bad.responses[0] as { error: string }).error).toMatch(/JSON/i);
    expect(empty.responses).toEqual([
      { error: 'request must include non-empty "text"' },
    ]);
    expect(good.responses).toEqual([
      { reply: 'echo: hi', recall: { count: 0 }, tools: [] },
    ]);
  });

  it('a core failure becomes an error reply, never a dead listener', async () => {
    const failing: ModelGateway = {
      complete: async () => {
        throw new Error('model endpoint unreachable');
      },
    };
    const first = request({ text: 'boom' });
    const second = request({ text: 'still here?' });
    const connection = fakeConnection([first, second]);
    const core = new SaoirseCore(new FakeMemory(), failing);

    const channel = attachNats({ core, connection, prefix: 'saoirse' });
    await channel.done;

    expect(first.responses).toEqual([{ error: 'model endpoint unreachable' }]);
    // The listener survived the failure and answered the next request.
    expect(second.responses).toHaveLength(1);
  });

  it('close() drains the connection', async () => {
    const connection = fakeConnection([]);
    const core = new SaoirseCore(new FakeMemory(), gateway);

    const channel = attachNats({ core, connection, prefix: 'saoirse' });
    await channel.close();

    expect(connection.isDrained()).toBe(true);
  });

  it('honors a custom subject prefix', async () => {
    const connection = fakeConnection([]);
    const core = new SaoirseCore(new FakeMemory(), gateway);

    const channel = attachNats({ core, connection, prefix: 'assistant' });
    expect(channel.subject).toBe('assistant.message');
    await channel.done;
  });
});
