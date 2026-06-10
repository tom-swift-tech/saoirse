// chat() speaks the standard /v1/chat/completions tools contract: tool
// definitions go out as {type:'function',function:{...}}, assistant tool-call
// turns and tool results round-trip with their ids, and the response's
// tool_calls come back parsed. Contracts, not products — nothing here is
// provider-specific.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { OpenAICompatibleGateway } from '../src/core/openai-compatible-gateway.js';

afterEach(() => vi.unstubAllGlobals());

interface WireBody {
  messages: Array<Record<string, unknown>>;
  tools?: Array<{ type: string; function: { name: string } }>;
}

function stubFetch(response: unknown): WireBody[] {
  const bodies: WireBody[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body));
      return {
        ok: true,
        status: 200,
        text: async () => '',
        json: async () => response,
      };
    }),
  );
  return bodies;
}

const gateway = () =>
  new OpenAICompatibleGateway({ url: 'http://localhost:11434', model: 'm' });

const TOOL = {
  name: 'clock',
  description: 'tell the time',
  parameters: { type: 'object', properties: {} },
};

describe('OpenAICompatibleGateway.chat — tools wire format', () => {
  it('sends tool definitions in the OpenAI function shape', async () => {
    const bodies = stubFetch({
      choices: [{ message: { content: 'hi' } }],
    });
    await gateway().chat([{ role: 'user', content: 'time?' }], {
      tools: [TOOL],
    });
    expect(bodies[0].tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'clock',
          description: 'tell the time',
          parameters: { type: 'object', properties: {} },
        },
      },
    ]);
  });

  it('omits the tools field entirely when none are offered', async () => {
    const bodies = stubFetch({ choices: [{ message: { content: 'hi' } }] });
    await gateway().chat([{ role: 'user', content: 'hi' }]);
    expect('tools' in bodies[0]).toBe(false);
  });

  it('parses tool_calls from the response', async () => {
    stubFetch({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              {
                id: 'call_abc',
                type: 'function',
                function: { name: 'clock', arguments: '{"tz":"UTC"}' },
              },
            ],
          },
        },
      ],
    });
    const turn = await gateway().chat([{ role: 'user', content: 'time?' }], {
      tools: [TOOL],
    });
    expect(turn.content).toBe('');
    expect(turn.toolCalls).toEqual([
      { id: 'call_abc', name: 'clock', arguments: '{"tz":"UTC"}' },
    ]);
  });

  it('round-trips assistant tool-call turns and tool results', async () => {
    const bodies = stubFetch({ choices: [{ message: { content: 'done' } }] });
    await gateway().chat([
      { role: 'user', content: 'time?' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call_abc', name: 'clock', arguments: '{}' }],
      },
      { role: 'tool', content: '10:00', toolCallId: 'call_abc' },
    ]);
    const [, assistant, tool] = bodies[0].messages;
    expect(assistant).toEqual({
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'call_abc',
          type: 'function',
          function: { name: 'clock', arguments: '{}' },
        },
      ],
    });
    expect(tool).toEqual({
      role: 'tool',
      content: '10:00',
      tool_call_id: 'call_abc',
    });
  });

  it('complete() still returns plain content (built on chat)', async () => {
    stubFetch({ choices: [{ message: { content: ' ok ' } }] });
    expect(await gateway().complete('hi')).toBe('ok');
  });
});
