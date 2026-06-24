// =============================================================================
// scheduler.ts — Scheduler: tick-driven job dispatcher.
//
// Seam rationale: every dependency (store, notifier, runPrompt, cronMatches)
// is injected so the scheduler is pure logic — no file system, no HTTP, no
// model call — and can be exercised in tests by calling tick() directly with
// a fixed Date, no timers required.
//
// Due/fire logic:
//   `at`   — fires when now >= the parsed ISO timestamp AND lastRun is absent
//             (one-shot: disables itself after a successful fire so it never
//             fires again even if it stays in the store).
//   `cron` — fires when cronMatches returns true AND the job has not already
//             fired within this same wall-clock minute. "Same minute" is
//             compared by flooring both now and lastRun to the minute boundary:
//             Math.floor(ms / 60_000). This is a deterministic integer compare
//             that survives DST because it works in UTC milliseconds.
//
// Error isolation: each job is wrapped in its own try/catch so a single
// failing action (e.g. notifier unreachable) never prevents the remaining
// jobs from being evaluated on the same tick. A failed job does NOT have its
// lastRun updated — this means a cron job will retry on the next tick within
// the same minute, which is fine for the notification use-case (idempotent
// actions) and beats silently dropping the job. Document this choice here so
// future maintainers can choose a different policy.
// =============================================================================

import type {
  JobStore,
  Notifier,
  PromptRunner,
  CronMatcher,
  Job,
} from './jobs.js';

interface SchedulerDeps {
  store: JobStore;
  notifier: Notifier;
  runPrompt: PromptRunner;
  cronMatches: CronMatcher;
  /** Tick interval in ms. Defaults to 60_000 (one minute). */
  tickMs?: number;
}

export class Scheduler {
  private readonly store: JobStore;
  private readonly notifier: Notifier;
  private readonly runPrompt: PromptRunner;
  private readonly cronMatches: CronMatcher;
  private readonly tickMs: number;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(deps: SchedulerDeps) {
    this.store = deps.store;
    this.notifier = deps.notifier;
    this.runPrompt = deps.runPrompt;
    this.cronMatches = deps.cronMatches;
    this.tickMs = deps.tickMs ?? 60_000;
  }

  start(): void {
    this.timer = setInterval(() => void this.tick(new Date()), this.tickMs);
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async tick(now: Date): Promise<void> {
    const jobs = this.store.list();
    for (const job of jobs) {
      if (!job.enabled) continue;
      if (!this.isDue(job, now)) continue;

      try {
        await this.fire(job, now);
      } catch (err) {
        // Log and continue — one job's failure must not stall the others.
        // lastRun is not updated on failure so the job can retry next tick.
        console.error(`[scheduler] job ${job.id} failed:`, err);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private isDue(job: Job, now: Date): boolean {
    const { schedule } = job;
    if (schedule.kind === 'at') {
      // One-shot: fire once when the wall time has passed. lastRun is the
      // "already fired" marker — if set, this job has already run.
      return now.getTime() >= Date.parse(schedule.iso) && job.lastRun === undefined;
    }
    // cron: fire when the expression matches AND we haven't fired in this
    // same minute yet (integer floor comparison, UTC-safe).
    if (!this.cronMatches(schedule.expr, now)) return false;
    if (job.lastRun === undefined) return true;
    const nowMin = Math.floor(now.getTime() / 60_000);
    const lastMin = Math.floor(Date.parse(job.lastRun) / 60_000);
    return nowMin !== lastMin;
  }

  private async fire(job: Job, now: Date): Promise<void> {
    const { action } = job;
    if (action.type === 'notify') {
      await this.notifier.notify({ message: action.text });
    } else {
      // prompt: run through the core, then deliver the reply as a notification.
      const reply = await this.runPrompt(action.prompt);
      await this.notifier.notify({ title: 'Saoirse', message: reply });
    }

    // Successful fire: stamp lastRun and disable one-shot jobs.
    const updated: Job = { ...job, lastRun: now.toISOString() };
    if (job.schedule.kind === 'at') updated.enabled = false;
    this.store.update(updated);
  }
}
