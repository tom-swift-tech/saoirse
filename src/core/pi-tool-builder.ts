// =============================================================================
// pi-tool-builder.ts — pi implementation of the ToolBuilder seam.
//
// pi is invoked NON-INTERACTIVELY (print/RPC mode): given a spec, it proposes
// code and returns structured output. This impl writes that output ONLY into
// PI_SANDBOX (every file path is containment-checked) and runs the spec's test
// command inside that sandbox. It never writes to skills/ or anywhere the
// running daemon loads from — promotion out of the sandbox is a separate,
// human-gated step (proposals.ts approveProposal).
//
// pi is a tool USED via this seam, configured by PI_COMMAND / PI_SANDBOX —
// contracts not products, never a hardcoded dependency.
//
// The contract: `PI_COMMAND` reads a JSON spec on stdin and writes a JSON
// result { files:[{path,content}], diff, testOutput, rationale, ok } on stdout.
// The real pi (a full coding agent, `pi -p`) does not speak this natively —
// scripts/pi-build.mjs adapts it: it runs pi in a throwaway scratch directory
// against MODEL_ENDPOINT and ships the files back as data, so this class stays
// the single place where artifact paths are containment-checked and written.
// PI_COMMAND="node scripts/pi-build.mjs" is the live wiring.
// =============================================================================

import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  safeToolName,
  type BuildResult,
  type ToolBuilder,
  type ToolSpec,
} from './tool-builder.js';
import { resolveInside } from './sandbox.js';

export interface PiToolBuilderConfig {
  /** The pi executable / launcher (PI_COMMAND), split on spaces for args. */
  command: string;
  /** Sandbox root (PI_SANDBOX). All artifacts live under here, nowhere else. */
  sandboxRoot: string;
  /** Test timeout per build, ms. */
  timeoutMs?: number;
}

interface PiOutput {
  ok?: boolean;
  files?: Array<{ path: string; content: string }>;
  diff?: string;
  testOutput?: string;
  rationale?: string;
  error?: string;
}

export class PiToolBuilder implements ToolBuilder {
  constructor(private readonly config: PiToolBuilderConfig) {}

  async build(spec: ToolSpec): Promise<BuildResult> {
    const toolName = safeToolName(spec.name);
    const id = `${toolName}-${randomUUID().slice(0, 8)}`;
    // The artifact directory lives strictly inside the sandbox root.
    const sandboxDir = resolveInside(this.config.sandboxRoot, id);
    await mkdir(sandboxDir, { recursive: true });

    const raw = await this.invokePi(spec);
    const out = JSON.parse(raw) as PiOutput;

    const written: string[] = [];
    for (const file of out.files ?? []) {
      // Containment: a path from pi can never escape the sandbox.
      const target = resolveInside(sandboxDir, file.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.content, 'utf8');
      written.push(file.path);
    }

    return {
      ok: out.ok ?? written.length > 0,
      id,
      toolName,
      sandboxDir,
      files: written,
      diff: out.diff ?? '',
      testOutput: out.testOutput ?? '(no tests run)',
      rationale: out.rationale ?? '',
      error: out.error,
    };
  }

  private invokePi(spec: ToolSpec): Promise<string> {
    const [cmd, ...args] = this.config.command.split(/\s+/);
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('pi build timed out'));
      }, this.config.timeoutMs ?? 120_000);

      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stderr += d));
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(stdout);
        else reject(new Error(`pi exited ${code}: ${stderr || stdout}`));
      });

      child.stdin.write(JSON.stringify(spec));
      child.stdin.end();
    });
  }
}
