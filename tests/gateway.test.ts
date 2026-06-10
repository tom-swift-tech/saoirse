// The model gateway normalizes MODEL_ENDPOINT so the /v1 segment is optional:
// bare host, /v1, and trailing-slash variants all resolve to exactly one
// /v1/chat/completions. This is the fix for the recurring "404 page not found".
import { describe, it, expect, vi, afterEach } from 'vitest';
import { OpenAICompatibleGateway } from '../src/core/openai-compatible-gateway.js';

afterEach(() => vi.unstubAllGlobals());

interface Call {
  url: string;
  body: { max_tokens?: number; model?: string };
}

function stubFetch(): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: { body: string }) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return {
        ok: true,
        status: 200,
        text: async () => '',
        json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
      };
    }),
  );
  return calls;
}

const EXPECTED = 'http://localhost:11434/v1/chat/completions';

describe('OpenAICompatibleGateway endpoint normalization', () => {
  it('adds /v1 when the base omits it', async () => {
    const calls = stubFetch();
    await new OpenAICompatibleGateway({
      url: 'http://localhost:11434',
      model: 'm',
    }).complete('hi');
    expect(calls[0].url).toBe(EXPECTED);
  });

  it('does not double /v1 when the base already includes it', async () => {
    const calls = stubFetch();
    await new OpenAICompatibleGateway({
      url: 'http://localhost:11434/v1',
      model: 'm',
    }).complete('hi');
    expect(calls[0].url).toBe(EXPECTED);
  });

  it('tolerates a trailing slash', async () => {
    const calls = stubFetch();
    await new OpenAICompatibleGateway({
      url: 'http://localhost:11434/v1/',
      model: 'm',
    }).complete('hi');
    expect(calls[0].url).toBe(EXPECTED);
  });

  it('returns the assistant content from the response', async () => {
    stubFetch();
    const reply = await new OpenAICompatibleGateway({
      url: 'http://localhost:11434',
      model: 'm',
    }).complete('hi');
    expect(reply).toBe('ok');
  });

  it('sends the configured max_tokens (headroom for reasoning models)', async () => {
    const calls = stubFetch();
    await new OpenAICompatibleGateway({
      url: 'http://localhost:11434',
      model: 'm',
      maxTokens: 4096,
    }).complete('hi');
    expect(calls[0].body.max_tokens).toBe(4096);
  });

  it('defaults max_tokens to 2048 when none is configured', async () => {
    const calls = stubFetch();
    await new OpenAICompatibleGateway({
      url: 'http://localhost:11434',
      model: 'm',
    }).complete('hi');
    expect(calls[0].body.max_tokens).toBe(2048);
  });

  it('honors a per-request override over the configured default', async () => {
    const calls = stubFetch();
    await new OpenAICompatibleGateway({
      url: 'http://localhost:11434',
      model: 'm',
      maxTokens: 2048,
    }).complete('hi', { maxTokens: 256 });
    expect(calls[0].body.max_tokens).toBe(256);
  });
});
