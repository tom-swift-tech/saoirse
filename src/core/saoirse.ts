// =============================================================================
// saoirse.ts — The core.
//
// Transport-agnostic and independently callable. Channels (HTTP, WS, CLI/TUI,
// NATS) are thin clients over handleMessage() — they hold no logic. The whole
// loop is:
//
//   utterance -> Engram recall -> model call -> [skill calls]* -> reply
//             -> Engram retain -> out
//
// The bracketed step is the committed-skill loop: when skills are loaded AND
// the gateway supports tool calling, the model may invoke promoted skills;
// each request is executed by the SkillRunner and fed back until the model
// answers in text (bounded — see MAX_TOOL_ROUNDS).
// =============================================================================

import type { Memory } from './memory.js';
import type {
  ChatMessage,
  ModelGateway,
  ToolCallRequest,
} from './model-gateway.js';
import type { BuildResult, ToolBuilder, ToolSpec } from './tool-builder.js';
import type { LoadedSkill } from './skills.js';
import { toToolDefinition } from './skills.js';
import type { SkillRunner } from './skill-runner.js';
import { writeProposal, type ToolProposalRecord } from '../proposals.js';

const SYSTEM_PROMPT =
  'You are Saoirse, a single persistent personal AI assistant for Tom Swift, ' +
  'reached through many channels. Answer concisely and helpfully, grounded in ' +
  'the recalled memory when it is relevant.';

/**
 * Hard ceiling on model<->skill round-trips per message. A model that loops on
 * tool calls fails visibly (the loop is cut and reported) instead of spinning.
 */
const MAX_TOOL_ROUNDS = 4;

export interface ToolCallTelemetry {
  name: string;
  ok: boolean;
}

export interface MessageResult {
  reply: string;
  sessionId: string;
  /** Recall telemetry for this turn — how many memories were surfaced. */
  recall: { count: number };
  /** Skill-call telemetry for this turn (empty when no skill ran). */
  tools: ToolCallTelemetry[];
}

/**
 * Tool-building wiring for the core. Deliberately carries proposalsDir but NOT
 * skillsDir: the core can enqueue a proposal, never promote one. Promotion is a
 * separate, token-gated action (proposals.ts approveProposal).
 */
export interface ToolKit {
  builder: ToolBuilder;
  proposalsDir: string;
}

/**
 * Committed skills available to the model this run. Loaded ONCE at daemon
 * start from the live skills/ directory — the running process never gains a
 * capability mid-session (promotion takes effect on the next start).
 */
export interface SkillKit {
  skills: LoadedSkill[];
  runner: SkillRunner;
}

export type BuildOutcome =
  | { ok: true; proposalId: string; status: 'pending'; toolName: string }
  | { ok: false; error: string };

export class SaoirseCore {
  constructor(
    private readonly memory: Memory,
    private readonly gateway: ModelGateway,
    private readonly toolKit?: ToolKit,
    private readonly skillKit?: SkillKit,
  ) {}

  /** Names of the committed skills the model can call this run. */
  get skillNames(): string[] {
    return (this.skillKit?.skills ?? []).map((s) => s.name);
  }

  async handleMessage(text: string): Promise<MessageResult> {
    const recalled = await this.memory.recall(text);
    const prompt = buildPrompt(text, recalled.text);

    const { reply, tools } = await this.generate(prompt);

    await this.memory.retain({ user: text, assistant: reply });
    return {
      reply,
      sessionId: recalled.sessionId,
      recall: { count: recalled.count ?? 0 },
      tools,
    };
  }

  /**
   * One generation: plain completion when no skills are loaded (or the gateway
   * cannot offer tools); otherwise the bounded model<->skill loop.
   */
  private async generate(
    prompt: string,
  ): Promise<{ reply: string; tools: ToolCallTelemetry[] }> {
    const skills = this.skillKit?.skills ?? [];
    const chat = this.gateway.chat?.bind(this.gateway);
    if (skills.length === 0 || !chat) {
      const reply = await this.gateway.complete(prompt, {
        system: SYSTEM_PROMPT,
      });
      return { reply, tools: [] };
    }

    const definitions = skills.map(toToolDefinition);
    const messages: ChatMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: prompt },
    ];
    const telemetry: ToolCallTelemetry[] = [];

    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const turn = await chat(messages, { tools: definitions });
      if (turn.toolCalls.length === 0) {
        return { reply: turn.content, tools: telemetry };
      }

      messages.push({
        role: 'assistant',
        content: turn.content,
        toolCalls: turn.toolCalls,
      });
      for (const call of turn.toolCalls) {
        const result = await this.executeSkillCall(call);
        telemetry.push({ name: call.name, ok: result.ok });
        messages.push({
          role: 'tool',
          content: result.output,
          toolCallId: call.id,
        });
      }
    }

    // Loop ceiling hit: fail visibly, never spin. The partial work is logged.
    console.error(
      `[saoirse] tool loop exceeded ${MAX_TOOL_ROUNDS} rounds — cutting off`,
    );
    return {
      reply:
        'I kept calling tools without reaching an answer and stopped myself. ' +
        `(${telemetry.map((t) => t.name).join(', ') || 'no calls completed'})`,
      tools: telemetry,
    };
  }

  /** Execute one model-requested skill call. Failures become tool results, never throws. */
  private async executeSkillCall(
    call: ToolCallRequest,
  ): Promise<{ ok: boolean; output: string }> {
    const skill = this.skillKit?.skills.find((s) => s.name === call.name);
    if (!skill || !this.skillKit) {
      return { ok: false, output: `unknown tool: ${call.name}` };
    }
    try {
      const outcome = await this.skillKit.runner.run(skill, call.arguments);
      if (!outcome.ok) {
        console.error(`[saoirse] skill "${call.name}" failed:`, outcome.output);
      }
      return outcome;
    } catch (err) {
      console.error(`[saoirse] skill "${call.name}" error:`, err);
      return {
        ok: false,
        output: `skill "${call.name}" error: ${(err as Error).message}`,
      };
    }
  }

  /** Whether tool-building is configured (PI_COMMAND set). */
  get canBuildTools(): boolean {
    return this.toolKit !== undefined;
  }

  /**
   * ACCRETE a tool: the builder produces a sandboxed artifact and this writes a
   * PENDING proposal. It NEVER promotes — no skills/ write exists on this path.
   * A failed build is logged (never swallowed) and leaves the running daemon's
   * capabilities entirely unchanged.
   */
  async handleBuildRequest(spec: ToolSpec): Promise<BuildOutcome> {
    if (!this.toolKit) {
      throw new Error('tool building is not configured (PI_COMMAND unset)');
    }

    let result: BuildResult;
    try {
      result = await this.toolKit.builder.build(spec);
    } catch (err) {
      console.error('[saoirse] tool build error:', err);
      return { ok: false, error: (err as Error).message };
    }

    if (!result.ok) {
      console.error('[saoirse] tool build failed:', result.error);
      return { ok: false, error: result.error ?? 'build failed' };
    }

    const record: ToolProposalRecord = {
      id: result.id,
      status: 'pending',
      tier: 1,
      toolName: result.toolName,
      spec: { name: spec.name, description: spec.description, test: spec.test },
      sandboxDir: result.sandboxDir,
      files: result.files,
      rationale: result.rationale,
      diff: result.diff,
      testOutput: result.testOutput,
    };
    await writeProposal(this.toolKit.proposalsDir, record);
    return {
      ok: true,
      proposalId: record.id,
      status: 'pending',
      toolName: record.toolName,
    };
  }
}

function buildPrompt(text: string, context: string): string {
  if (!context.trim()) return text;
  return `Relevant memory:\n${context}\n\nUser message:\n${text}`;
}
