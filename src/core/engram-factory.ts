// =============================================================================
// engram-factory.ts — Composition seam for building the pinned Engram.
//
// The core is provider-agnostic; this is where the daemon chooses how Engram
// embeds. Default is Ollama (boot-safe: an unreachable endpoint fails
// per-message, never at create). Offline/dev boot uses a deterministic
// network-free embedder so the daemon breathes without a model download or
// network. Engram's in-process local model is deliberate opt-in — it imports
// the deprecated transformers chain and a failed download kills boot.
// =============================================================================

import { Engram } from 'engram';
import type { SaoirseConfig } from '../config.js';
import { OfflineEmbedder } from './offline-embedder.js';

export async function createEngram(config: SaoirseConfig): Promise<Engram> {
  switch (config.engramEmbeddings) {
    case 'offline':
      return Engram.create(config.engramDb, {
        embedder: new OfflineEmbedder(),
      });
    case 'ollama':
      return Engram.create(config.engramDb, { useOllamaEmbeddings: true });
    case 'local':
    default:
      // Engram's default LocalEmbedder (Transformers.js). Downloads the model
      // on first use — requires network the first time.
      return Engram.create(config.engramDb);
  }
}
