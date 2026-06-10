// =============================================================================
// memory.ts — The memory seam, wrapping the pinned Engram class.
//
// The core depends only on the Memory interface — recall() before responding,
// retain() after. EngramMemory is the real implementation over the imported
// (pinned) Engram. Keeping this seam thin means a future re-pin of Engram, or a
// fake in tests, never touches core logic.
// =============================================================================

import type { Engram } from 'engram';

export interface RecalledContext {
  /** Formatted long-term context, ready to drop into a prompt. */
  text: string;
  /** The working-memory session this message was inferred to belong to. */
  sessionId: string;
  /** Whether an existing session was resumed or a new one was created. */
  reason: 'match' | 'new' | 'forced';
  /** How many memory items were surfaced into `text` for this turn. */
  count: number;
}

export interface Exchange {
  user: string;
  assistant: string;
}

/** The memory seam the core depends on. */
export interface Memory {
  recall(message: string): Promise<RecalledContext>;
  retain(exchange: Exchange): Promise<void>;
  close(): void;
}

export class EngramMemory implements Memory {
  constructor(private readonly engram: Engram) {}

  async recall(message: string): Promise<RecalledContext> {
    // Working-memory session inference runs once per incoming message. It also
    // loads related long-term context (RRF-fused recall under the hood) seeded
    // by the session goal, already formatted for a prompt.
    const result = await this.engram.inferWorkingSession(message);
    return {
      text: result.relatedContext,
      sessionId: result.session.id,
      reason: result.diagnostics.reason,
      count: countSurfacedMemories(result.relatedContext),
    };
  }

  async retain(exchange: Exchange): Promise<void> {
    const text = `User: ${exchange.user}\nSaoirse: ${exchange.assistant}`;
    await this.engram.retain(text, {
      memoryType: 'experience',
      source: 'saoirse:conversation',
      sourceType: 'agent_generated',
    });
  }

  close(): void {
    this.engram.close();
  }
}

/**
 * Count the memory items surfaced in a formatted recall context. Engram's
 * formatForPrompt renders each surfaced item as a "- " bullet, so counting them
 * gives an honest "how many memories made it into this turn" figure without
 * reaching into Engram internals.
 */
function countSurfacedMemories(context: string): number {
  if (!context.trim()) return 0;
  return context.split('\n').filter((line) => line.trimStart().startsWith('- '))
    .length;
}
