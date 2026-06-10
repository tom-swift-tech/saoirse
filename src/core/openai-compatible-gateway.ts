// =============================================================================
// openai-compatible-gateway.ts — OpenAI-compatible implementation of ModelGateway.
//
// Saoirse depends on the OpenAI /v1/chat/completions contract, not on any one
// product. The endpoint is whatever serves that contract, supplied via
// MODEL_ENDPOINT; interchangeable backends are config values, never names in
// source. Zero cloud API cost is a standing principle (SYSTEM.md); no cloud API
// is hardcoded.
//
// Note: this targets the common /v1/chat/completions contract only — including
// its standard `tools` / `tool_calls` fields for the chat() capability. Any
// provider-specific extensions are optional config, never assumptions here.
//
// MODEL_ENDPOINT is the OpenAI-style base_url. It may be given with OR without a
// trailing /v1 (e.g. http://host:11434 or http://host:11434/v1) — the gateway
// normalizes to exactly one /v1/chat/completions either way, so neither a
// missing nor a doubled version path can break the call.
// =============================================================================

import type {
  AssistantTurn,
  ChatMessage,
  ChatOptions,
  CompletionOptions,
  ModelGateway,
  ToolCallRequest,
} from './model-gateway.js';

export interface OpenAICompatibleGatewayConfig {
  /** Base URL of an OpenAI-compatible endpoint; the /v1 segment is optional (MODEL_ENDPOINT). */
  url: string;
  /** Model id to request (MODEL_NAME). */
  model: string;
  /** Default max completion tokens (MODEL_MAX_TOKENS). Reasoning models need headroom. */
  maxTokens?: number;
}

/** Wire shapes of the /v1/chat/completions contract. */
interface WireToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface WireMessage {
  role: string;
  content: string | null;
  tool_calls?: WireToolCall[];
  tool_call_id?: string;
}

interface WireResponse {
  choices?: Array<{
    message?: { content?: string | null; tool_calls?: WireToolCall[] };
  }>;
}

export class OpenAICompatibleGateway implements ModelGateway {
  constructor(private readonly config: OpenAICompatibleGatewayConfig) {}

  async complete(
    prompt: string,
    options: CompletionOptions = {},
  ): Promise<string> {
    const messages: ChatMessage[] = [];
    if (options.system) {
      messages.push({ role: 'system', content: options.system });
    }
    messages.push({ role: 'user', content: prompt });

    const turn = await this.chat(messages, options);
    if (!turn.content) {
      throw new Error('Model endpoint returned no completion content');
    }
    return turn.content;
  }

  async chat(
    messages: ChatMessage[],
    options: ChatOptions = {},
  ): Promise<AssistantTurn> {
    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: messages.map(toWireMessage),
      temperature: options.temperature ?? 0.7,
      max_tokens: options.maxTokens ?? this.config.maxTokens ?? 2048,
      stream: false,
    };
    if (options.tools?.length) {
      body.tools = options.tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      }));
    }

    // Normalize: drop trailing slashes and a trailing /v1, then build exactly
    // one /v1/chat/completions. Works whether MODEL_ENDPOINT includes /v1 or not.
    const base = this.config.url.replace(/\/+$/, '').replace(/\/v1$/, '');
    const endpoint = `${base}/v1/chat/completions`;
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Model endpoint error ${res.status}: ${detail}`);
    }

    const data = (await res.json()) as WireResponse;
    const message = data.choices?.[0]?.message;
    if (!message) {
      throw new Error('Model endpoint returned no completion message');
    }
    return {
      content: (message.content ?? '').trim(),
      toolCalls: (message.tool_calls ?? [])
        .filter((c) => c.function?.name)
        .map(
          (c, i): ToolCallRequest => ({
            id: c.id ?? `call_${i}`,
            name: c.function?.name ?? '',
            arguments: c.function?.arguments ?? '{}',
          }),
        ),
    };
  }
}

function toWireMessage(msg: ChatMessage): WireMessage {
  const wire: WireMessage = { role: msg.role, content: msg.content };
  if (msg.toolCalls?.length) {
    wire.tool_calls = msg.toolCalls.map((call) => ({
      id: call.id,
      type: 'function',
      function: { name: call.name, arguments: call.arguments },
    }));
  }
  if (msg.toolCallId) {
    wire.tool_call_id = msg.toolCallId;
  }
  return wire;
}
