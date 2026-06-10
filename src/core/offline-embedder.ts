// =============================================================================
// offline-embedder.ts — Deterministic, network-free EmbeddingProvider.
//
// The production default embedder (Engram's LocalEmbedder) downloads a ~100MB
// model from HuggingFace on first use. That makes the daemon un-bootable
// offline / in CI / on a fresh box. This provider hashes tokens into a fixed
// vector so recall works with ZERO network and zero model download.
//
// It is for dev / offline boot only — recall quality is approximate, not
// semantic. Select it with ENGRAM_EMBEDDINGS=offline. Never use for production
// recall against real long-term memory.
// =============================================================================

import type { EmbeddingProvider } from 'engram';

const DIMENSIONS = 768; // match Engram's nomic default so DBs stay dim-consistent

export class OfflineEmbedder implements EmbeddingProvider {
  readonly dimensions = DIMENSIONS;

  async embed(text: string): Promise<Float32Array> {
    const vec = new Float32Array(DIMENSIONS);
    const tokens = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
    for (const token of tokens) {
      const h = fnv1a(token);
      const idx = h % DIMENSIONS;
      // Signed hashing keeps the space spread out; shared tokens still align,
      // which gives a usable (if coarse) cosine similarity.
      vec[idx] += (h >>> 16) & 1 ? 1 : -1;
    }
    let norm = 0;
    for (let i = 0; i < DIMENSIONS; i++) norm += vec[i] * vec[i];
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < DIMENSIONS; i++) vec[i] /= norm;
    return vec;
  }
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
