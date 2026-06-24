// =============================================================================
// jobs.ts — contracts for the proactivity primitive (P2): scheduled jobs +
// outbound notify.
//
// Saoirse is otherwise purely reactive — she acts only when spoken to. This is
// the seam that lets her INITIATE: a persistent job fires on a schedule, and the
// result is delivered through a Notifier that reaches the user even when no
// dashboard is open. Seams, not products: Notifier is an interface (ntfy is the
// first impl); the cron matcher and the prompt runner are injected, so the
// scheduler is pure logic over its dependencies and trivially testable.
//
// Two action shapes keep it cheap AND smart: `notify` delivers literal text (a
// plain reminder, no model call); `prompt` runs through the core and delivers
// the model's reply (a digest, a summary).
// =============================================================================

/** When a job fires. `at` is one-shot; `cron` is a recurring 5-field expr (minute granularity). */
export type Schedule =
  | { kind: 'at'; iso: string }
  | { kind: 'cron'; expr: string };

/** What a job does when it fires. */
export type JobAction =
  | { type: 'notify'; text: string }
  | { type: 'prompt'; prompt: string };

export interface Job {
  id: string;
  schedule: Schedule;
  action: JobAction;
  /** A disabled job is kept but never fires. One-shot `at` jobs disable themselves after firing. */
  enabled: boolean;
  createdAt: string;
  /** ISO of the last fire — also the "already fired" marker for one-shot jobs and
   *  the same-minute de-dupe guard for cron jobs. */
  lastRun?: string;
}

/** Persistence for jobs — survives restart (the daemon is always-on). */
export interface JobStore {
  list(): Job[];
  get(id: string): Job | undefined;
  add(job: Job): void;
  update(job: Job): void;
  remove(id: string): boolean;
}

/** An outbound message to the user. */
export interface Notification {
  title?: string;
  message: string;
}

/** Delivers a notification out-of-band (ntfy first). Best-effort: implementations
 *  must not throw — a failed delivery is logged, never allowed to break a tick. */
export interface Notifier {
  notify(n: Notification): Promise<void>;
}

/** True if a 5-field cron expression matches `date` (minute granularity). Injected
 *  into the scheduler so the matcher and the scheduler are independently testable. */
export type CronMatcher = (expr: string, date: Date) => boolean;

/** Runs a prompt through the core and resolves the reply text. Injected so the
 *  scheduler depends on a function, not on SaoirseCore. */
export type PromptRunner = (prompt: string) => Promise<string>;
