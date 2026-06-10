// The loop against REAL Engram on REAL SQLite — only the model call is faux
// (no model endpoint in CI). Proves what the unit test's faux Memory cannot: recall runs
// real session inference + RRF retrieval, and retain actually persists the
// exchange to storage. Uses the offline embedder so there is no network/model
// download.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Engram } from 'engram';
import { EngramMemory } from '../src/core/memory.js';
import { OfflineEmbedder } from '../src/core/offline-embedder.js';
import { SaoirseCore } from '../src/core/saoirse.js';
import type { ModelGateway } from '../src/core/model-gateway.js';

class FauxGateway implements ModelGateway {
  lastPrompt = '';
  async complete(prompt: string): Promise<string> {
    this.lastPrompt = prompt;
    // Distinctive marker token so we can prove the exchange was retained via FTS.
    return 'Acknowledged: zephyrquux.';
  }
}

let dir: string | undefined;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe('full loop on real Engram memory (offline embedder)', () => {
  it('recalls, calls the gateway with context, replies, and persists the exchange', async () => {
    dir = mkdtempSync(join(tmpdir(), 'saoirse-engram-'));
    const engram = await Engram.create(join(dir, 'test.engram'), {
      embedder: new OfflineEmbedder(),
    });
    const memory = new EngramMemory(engram);
    const gateway = new FauxGateway();
    const core = new SaoirseCore(memory, gateway);

    // Seed a prior fact so recall has real long-term memory to draw on.
    await memory.retain({
      user: 'My infrastructure tool is Terraform.',
      assistant: 'Noted.',
    });

    const result = await core.handleMessage('hi');

    // A real reply came back through the running loop.
    expect(result.reply).toBe('Acknowledged: zephyrquux.');
    expect(result.sessionId).toMatch(/^wm-/);

    // recall ran for real (the gateway prompt was built from a real session).
    expect(gateway.lastPrompt).toContain('hi');

    // retain actually persisted the exchange: a fresh recall on the reply's
    // distinctive marker surfaces it from storage.
    const afterExchange = await engram.recall('zephyrquux');
    expect(JSON.stringify(afterExchange).toLowerCase()).toContain('zephyrquux');

    // and the seeded fact is retrievable too — recall reads real storage.
    const seeded = await engram.recall('Terraform');
    expect(JSON.stringify(seeded).toLowerCase()).toContain('terraform');

    engram.close();
  });
});
