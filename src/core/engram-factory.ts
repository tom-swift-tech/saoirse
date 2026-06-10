// =============================================================================
// engram-factory.ts — Composition seam for building the pinned Engram.
//
// The core is provider-agnostic; this is where the daemon chooses how Engram
// embeds. Production uses Engram's local model. Offline/dev boot uses a
// deterministic network-free embedder so the daemon breathes without a model
// download or network. Ollama embeddings are available for a self-hosted box.
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
