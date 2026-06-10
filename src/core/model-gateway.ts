// =============================================================================
// model-gateway.ts — The model seam.
//
// Every LLM call routes through a ModelGateway. The core depends only on this
// interface, so the concrete implementation can be swapped (or faked in tests)
// without touching core logic. This is the thin seam channels and future tiers
// plug into.
//
// `complete` is the required minimum (one prompt in, one reply out). `chat` is
// the optional tool-calling capability over the same /v1/chat/completions
// contract — optional because not every OpenAI-compatible server implements
// tools, and the core degrades gracefully (skills simply stay unused) rather
// than assuming a provider-specific extension (contracts, not products).
// =============================================================================

export interface CompletionOptions {
  /** System prompt / persona. */
  system?: string;
  temperature?: number;
  maxTokens?: number;
}

/** An OpenAI-style tool the model may call (name + JSON Schema parameters). */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** A tool invocation requested by the model. `arguments` is the raw JSON string. */
export interface ToolCallRequest {
  id: string;
  name: string;
  arguments: string;
}

/** One message in a chat exchange, including tool-call plumbing. */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Set on an assistant message that requested tool calls. */
  toolCalls?: ToolCallRequest[];
  /** Set on a tool message: which call this result answers. */
  toolCallId?: string;
}

export interface ChatOptions extends CompletionOptions {
  /** Tools offered to the model for this turn. */
  tools?: ToolDefinition[];
}

/** The assistant's turn: text, tool-call requests, or both. */
export interface AssistantTurn {
  content: string;
  toolCalls: ToolCallRequest[];
}

export interface ModelGateway {
  complete(prompt: string, options?: CompletionOptions): Promise<string>;
  /**
   * Multi-message exchange with optional tool calling. Implement when the
   * backing endpoint supports the `tools` field of /v1/chat/completions; the
   * core checks for its presence before offering skills to the model.
   */
  chat?(messages: ChatMessage[], options?: ChatOptions): Promise<AssistantTurn>;
}
