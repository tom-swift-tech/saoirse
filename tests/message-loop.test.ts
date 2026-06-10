// The whole point of the skeleton: prove the loop with faux seams — no live
// model endpoint, no real tokens (mirrors how engram's tests avoid live providers).
//   recall queried -> gateway called WITH recalled context -> reply -> retained
import { describe, it, expect } from 'vitest';
import { SaoirseCore } from '../src/core/saoirse.js';
import type { Memory, RecalledContext, Exchange } from '../src/core/memory.js';
import type {
  ModelGateway,
  CompletionOptions,
} from '../src/core/model-gateway.js';

class FakeMemory implements Memory {
  recalled: string[] = [];
  retained: Exchange[] = [];

  async recall(message: string): Promise<RecalledContext> {
    this.recalled.push(message);
    return {
      text: 'PRIOR: Tom prefers Terraform for IaC.',
      sessionId: 'wm-test',
      reason: 'match',
    };
  }

  async retain(exchange: Exchange): Promise<void> {
    this.retained.push(exchange);
  }

  close(): void {}
}

class FakeGateway implements ModelGateway {
  prompts: string[] = [];
  systems: Array<string | undefined> = [];

  async complete(prompt: string, options?: CompletionOptions): Promise<string> {
    this.prompts.push(prompt);
    this.systems.push(options?.system);
    return 'Hello from the faux gateway.';
  }
}

describe('SaoirseCore /message loop', () => {
  it('recalls, calls the gateway with the recalled context, replies, and retains', async () => {
    const memory = new FakeMemory();
    const gateway = new FakeGateway();
    const core = new SaoirseCore(memory, gateway);

    const result = await core.handleMessage("what's new");

    // recall queried with the incoming utterance
    expect(memory.recalled).toEqual(["what's new"]);

    // gateway called exactly once, with the recalled context AND the utterance
    // both present in the prompt
    expect(gateway.prompts).toHaveLength(1);
    expect(gateway.prompts[0]).toContain(
      'PRIOR: Tom prefers Terraform for IaC.',
    );
    expect(gateway.prompts[0]).toContain("what's new");
    // and a persona was supplied
    expect(gateway.systems[0]).toMatch(/Saoirse/);

    // reply returned
    expect(result.reply).toBe('Hello from the faux gateway.');
    expect(result.sessionId).toBe('wm-test');

    // the exchange was retained after responding
    expect(memory.retained).toEqual([
      { user: "what's new", assistant: 'Hello from the faux gateway.' },
    ]);
  });

  it('still calls the gateway when recall returns no context', async () => {
    const memory = new FakeMemory();
    memory.recall = async (message: string) => {
      memory.recalled.push(message);
      return { text: '', sessionId: 'wm-empty', reason: 'new' };
    };
    const gateway = new FakeGateway();
    const core = new SaoirseCore(memory, gateway);

    const result = await core.handleMessage('hi');

    expect(gateway.prompts[0]).toBe('hi');
    expect(result.reply).toBe('Hello from the faux gateway.');
    expect(memory.retained).toHaveLength(1);
  });
});
