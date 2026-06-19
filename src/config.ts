// =============================================================================
// config.ts — Environment configuration.
//
// All runtime configuration comes from the environment. No secrets in source.
// =============================================================================

export interface SaoirseConfig {
  /** HTTP/WS listener port. */
  port: number;
  /** Base URL of an OpenAI-compatible model endpoint; the /v1 segment is optional. */
  modelEndpoint: string;
  /** Model id to request from the endpoint. */
  modelName: string;
  /** Default max completion tokens (MODEL_MAX_TOKENS); per-request override via options.maxTokens. */
  modelMaxTokens: number;
  /** Auth token required on WS connect. Undefined => push channel fails closed. */
  token: string | undefined;
  /** Engram memory database path. */
  engramDb: string;
  /** How Engram embeds: Ollama (default), offline dev hashing, or opt-in local model. */
  engramEmbeddings: EmbeddingMode;
  /** pi launcher for tool-building (PI_COMMAND). Undefined => tool building disabled. */
  piCommand: string | undefined;
  /** Sandbox root for accreted, un-promoted tool artifacts (PI_SANDBOX). */
  piSandbox: string;
  /** Ceiling on one tool build, ms (PI_TIMEOUT_MS). Local-model agent builds are slow. */
  piTimeoutMs: number;
  /** East-west NATS fabric URL (NATS_URL). Undefined => no fabric listener. */
  natsUrl: string | undefined;
  /** Subject prefix on the fabric (NATS_PREFIX), e.g. "saoirse.message". */
  natsPrefix: string;
  /** Sandbox root for Tier-0 Engram candidate clones (ENGRAM_EVAL_SANDBOX). */
  engramEvalSandbox: string;
  /** Ceiling on one clone+install+test cycle, ms (ENGRAM_EVAL_TIMEOUT_MS). */
  engramEvalTimeoutMs: number;
  /** Known-good Engram test-count floor a candidate must meet (ENGRAM_BASELINE_TESTS). */
  engramBaselineTests: number;
  /** Optional override of the Engram clone source; default parsed from the pin (ENGRAM_REPO). */
  engramRepo: string | undefined;
}

export type EmbeddingMode = 'local' | 'ollama' | 'offline';

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
): SaoirseConfig {
  return {
    port: parseInt(env.PORT ?? '8787', 10),
    modelEndpoint: env.MODEL_ENDPOINT ?? 'http://localhost:11434',
    modelName: env.MODEL_NAME ?? 'local',
    modelMaxTokens: parseInt(env.MODEL_MAX_TOKENS ?? '2048', 10) || 2048,
    token: env.SAOIRSE_TOKEN || undefined,
    engramDb: env.ENGRAM_DB ?? './saoirse.engram',
    engramEmbeddings: parseEmbeddingMode(env.ENGRAM_EMBEDDINGS),
    piCommand: env.PI_COMMAND || undefined,
    piSandbox: env.PI_SANDBOX ?? './sandbox',
    piTimeoutMs: parseInt(env.PI_TIMEOUT_MS ?? '600000', 10) || 600_000,
    natsUrl: env.NATS_URL || undefined,
    natsPrefix: env.NATS_PREFIX ?? 'saoirse',
    engramEvalSandbox: env.ENGRAM_EVAL_SANDBOX ?? './engram-eval',
    engramEvalTimeoutMs:
      parseInt(env.ENGRAM_EVAL_TIMEOUT_MS ?? '900000', 10) || 900_000,
    engramBaselineTests: parseInt(env.ENGRAM_BASELINE_TESTS ?? '334', 10) || 334,
    engramRepo: env.ENGRAM_REPO || undefined,
  };
}

// Default is ollama: boot-safe (an unreachable endpoint degrades per-message,
// never kills the daemon) and avoids the vulnerable transformers chain that
// 'local' pulls in. 'local' is deliberate opt-in.
function parseEmbeddingMode(value: string | undefined): EmbeddingMode {
  if (value === 'local' || value === 'offline') return value;
  return 'ollama';
}
