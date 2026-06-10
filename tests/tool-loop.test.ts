// The model<->skill loop in the core: when skills are loaded and the gateway
// supports chat/tools, the model may call a skill; the result is fed back and
// the final text answer is the reply. Faux seams throughout — no subprocess,
// no live endpoint (mirrors message-loop.test.ts).
import { describe, it, expect } from 'vitest';
import { SaoirseCore, type SkillKit } from '../src/core/saoirse.js';
import type { Memory, RecalledContext, Exchange } from '../src/core/memory.js';
import type {
  AssistantTurn,
  ChatMessage,
  ChatOptions,
  ModelGateway,
} from '../src/core/model-gateway.js';
import type { LoadedSkill } from '../src/core/skills.js';
import type { SkillRunner, SkillRunOutcome } from '../src/core/skill-runner.js';

class FakeMemory implements Memory {
  retained: Exchange[] = [];
  async recall(): Promise<RecalledContext> {
    return { text: '', sessionId: 'wm-tools', reason: 'new', count: 0 };
  }
  async retain(exchange: Exchange): Promise<void> {
    this.retained.push(exchange);
  }
  close(): void {}
}

/** Scripted chat gateway: returns the queued turns in order. */
class FakeChatGateway implements ModelGateway {
  chats: Array<{ messages: ChatMessage[]; options?: ChatOptions }> = [];
  completes = 0;

  constructor(private readonly turns: AssistantTurn[]) {}

  async complete(): Promise<string> {
    this.completes++;
    return 'plain completion';
  }

  async chat(
    messages: ChatMessage[],
    options?: ChatOptions,
  ): Promise<AssistantTurn> {
    this.chats.push({ messages: [...messages], options });
    const turn = this.turns.shift();
    if (!turn) throw new Error('FakeChatGateway ran out of scripted turns');
    return turn;
  }
}

class FakeRunner implements SkillRunner {
  calls: Array<{ skill: string; args: string }> = [];
  constructor(private readonly outcome: SkillRunOutcome) {}
  async run(skill: LoadedSkill, args: string): Promise<SkillRunOutcome> {
    this.calls.push({ skill: skill.name, args });
    return this.outcome;
  }
}

const CLOCK: LoadedSkill = {
  name: 'clock',
  description: 'tell the current time',
  parameters: { type: 'object', properties: {} },
  dir: '/skills/clock',
  entry: '/skills/clock/run.mjs',
};

function kit(runner: SkillRunner, skills: LoadedSkill[] = [CLOCK]): SkillKit {
  return { skills, runner };
}

describe('SaoirseCore skill loop', () => {
  it('executes a requested skill, feeds the result back, and replies', async () => {
    const gateway = new FakeChatGateway([
      {
        content: '',
        toolCalls: [{ id: 'c1', name: 'clock', arguments: '{"tz":"UTC"}' }],
      },
      { content: 'It is 10:00 UTC.', toolCalls: [] },
    ]);
    const runner = new FakeRunner({ ok: true, output: '10:00' });
    const memory = new FakeMemory();
    const core = new SaoirseCore(memory, gateway, undefined, kit(runner));

    const result = await core.handleMessage('what time is it?');

    // The skill ran with the model's arguments…
    expect(runner.calls).toEqual([{ skill: 'clock', args: '{"tz":"UTC"}' }]);
    // …the tools were offered on every chat round…
    expect(gateway.chats[0].options?.tools).toEqual([
      {
        name: 'clock',
        description: 'tell the current time',
        parameters: { type: 'object', properties: {} },
      },
    ]);
    // …the second round saw the assistant tool-call turn AND the tool result…
    const second = gateway.chats[1].messages;
    expect(second.at(-2)).toMatchObject({
      role: 'assistant',
      toolCalls: [{ id: 'c1', name: 'clock' }],
    });
    expect(second.at(-1)).toMatchObject({
      role: 'tool',
      content: '10:00',
      toolCallId: 'c1',
    });
    // …and the final text is the reply, with telemetry, retained once.
    expect(result.reply).toBe('It is 10:00 UTC.');
    expect(result.tools).toEqual([{ name: 'clock', ok: true }]);
    expect(memory.retained).toEqual([
      { user: 'what time is it?', assistant: 'It is 10:00 UTC.' },
    ]);
  });

  it('answers directly (no skill run) when the model does not call one', async () => {
    const gateway = new FakeChatGateway([
      { content: 'Just an answer.', toolCalls: [] },
    ]);
    const runner = new FakeRunner({ ok: true, output: 'unused' });
    const core = new SaoirseCore(
      new FakeMemory(),
      gateway,
      undefined,
      kit(runner),
    );

    const result = await core.handleMessage('hi');
    expect(result.reply).toBe('Just an answer.');
    expect(result.tools).toEqual([]);
    expect(runner.calls).toEqual([]);
  });

  it('a failed skill run becomes a tool result the model can react to', async () => {
    const gateway = new FakeChatGateway([
      {
        content: '',
        toolCalls: [{ id: 'c1', name: 'clock', arguments: '{}' }],
      },
      { content: 'The clock is broken.', toolCalls: [] },
    ]);
    const runner = new FakeRunner({
      ok: false,
      output: 'skill "clock" exited 1',
    });
    const core = new SaoirseCore(
      new FakeMemory(),
      gateway,
      undefined,
      kit(runner),
    );

    const result = await core.handleMessage('time?');
    expect(gateway.chats[1].messages.at(-1)).toMatchObject({
      role: 'tool',
      content: 'skill "clock" exited 1',
    });
    expect(result.reply).toBe('The clock is broken.');
    expect(result.tools).toEqual([{ name: 'clock', ok: false }]);
  });

  it('an unknown tool name becomes an error tool result, never a crash', async () => {
    const gateway = new FakeChatGateway([
      {
        content: '',
        toolCalls: [{ id: 'c1', name: 'ghost', arguments: '{}' }],
      },
      { content: 'Never mind.', toolCalls: [] },
    ]);
    const runner = new FakeRunner({ ok: true, output: 'unused' });
    const core = new SaoirseCore(
      new FakeMemory(),
      gateway,
      undefined,
      kit(runner),
    );

    const result = await core.handleMessage('hm');
    expect(gateway.chats[1].messages.at(-1)).toMatchObject({
      role: 'tool',
      content: 'unknown tool: ghost',
    });
    expect(result.tools).toEqual([{ name: 'ghost', ok: false }]);
    expect(runner.calls).toEqual([]);
  });

  it('cuts off a model that loops on tool calls (bounded rounds)', async () => {
    const call = {
      content: '',
      toolCalls: [{ id: 'c', name: 'clock', arguments: '{}' }],
    };
    // More scripted tool-call turns than the loop will ever consume.
    const gateway = new FakeChatGateway(Array(10).fill(call));
    const runner = new FakeRunner({ ok: true, output: '10:00' });
    const core = new SaoirseCore(
      new FakeMemory(),
      gateway,
      undefined,
      kit(runner),
    );

    const result = await core.handleMessage('time?');
    expect(result.reply).toMatch(/stopped myself/);
    expect(gateway.chats.length).toBeLessThanOrEqual(5);
  });

  it('falls back to plain completion when no skills are committed', async () => {
    const gateway = new FakeChatGateway([]);
    const runner = new FakeRunner({ ok: true, output: 'unused' });
    const core = new SaoirseCore(
      new FakeMemory(),
      gateway,
      undefined,
      kit(runner, []),
    );

    const result = await core.handleMessage('hi');
    expect(result.reply).toBe('plain completion');
    expect(gateway.completes).toBe(1);
    expect(gateway.chats).toEqual([]);
  });

  it('falls back to plain completion when the gateway has no chat capability', async () => {
    let completed = 0;
    const gateway: ModelGateway = {
      complete: async () => {
        completed++;
        return 'plain completion';
      },
    };
    const runner = new FakeRunner({ ok: true, output: 'unused' });
    const core = new SaoirseCore(
      new FakeMemory(),
      gateway,
      undefined,
      kit(runner),
    );

    const result = await core.handleMessage('hi');
    expect(result.reply).toBe('plain completion');
    expect(completed).toBe(1);
    expect(result.tools).toEqual([]);
  });
});
