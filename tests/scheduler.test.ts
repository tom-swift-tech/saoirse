// Unit tests for Scheduler.
//
// All tests call tick(fixedDate) directly — no timers, no setInterval.
// All dependencies are injected fakes: an in-memory store, a notifier that
// records calls, a runPrompt stub, and a cronMatches stub. This makes every
// assertion deterministic and free of I/O.
import { describe, it, expect, vi } from 'vitest';
import { Scheduler } from '../src/core/scheduler.js';
import type { Job, JobStore, Notifier, Notification, PromptRunner, CronMatcher } from '../src/core/jobs.js';

// ---------------------------------------------------------------------------
// Fake implementations
// ---------------------------------------------------------------------------

class MemoryJobStore implements JobStore {
  private jobs: Job[] = [];

  seed(jobs: Job[]): void {
    this.jobs = jobs.map((j) => ({ ...j }));
  }

  list(): Job[] {
    return [...this.jobs];
  }

  get(id: string): Job | undefined {
    return this.jobs.find((j) => j.id === id);
  }

  add(job: Job): void {
    this.jobs.push({ ...job });
  }

  update(job: Job): void {
    const idx = this.jobs.findIndex((j) => j.id === job.id);
    if (idx !== -1) this.jobs[idx] = { ...job };
  }

  remove(id: string): boolean {
    const before = this.jobs.length;
    this.jobs = this.jobs.filter((j) => j.id !== id);
    return this.jobs.length !== before;
  }
}

function makeStore(...jobs: Job[]): MemoryJobStore {
  const s = new MemoryJobStore();
  s.seed(jobs);
  return s;
}

function makeNotifier(): { notifier: Notifier; calls: Notification[] } {
  const calls: Notification[] = [];
  const notifier: Notifier = { notify: vi.fn(async (n) => { calls.push(n); }) };
  return { notifier, calls };
}

// ---------------------------------------------------------------------------
// Job factories
// ---------------------------------------------------------------------------

const FIXED_NOW = new Date('2026-06-24T12:00:00.000Z');
const PAST_ISO = '2026-06-24T11:59:00.000Z';   // before FIXED_NOW → due
const FUTURE_ISO = '2026-06-24T13:00:00.000Z'; // after  FIXED_NOW → not due

function atNotifyJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'j-at-notify',
    schedule: { kind: 'at', iso: PAST_ISO },
    action: { type: 'notify', text: 'Time to stand up!' },
    enabled: true,
    createdAt: '2026-06-24T00:00:00.000Z',
    ...overrides,
  };
}

function atPromptJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'j-at-prompt',
    schedule: { kind: 'at', iso: PAST_ISO },
    action: { type: 'prompt', prompt: 'Summarise my todos' },
    enabled: true,
    createdAt: '2026-06-24T00:00:00.000Z',
    ...overrides,
  };
}

function cronNotifyJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'j-cron',
    schedule: { kind: 'cron', expr: '0 12 * * *' },
    action: { type: 'notify', text: 'Noon check-in' },
    enabled: true,
    createdAt: '2026-06-24T00:00:00.000Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test suites
// ---------------------------------------------------------------------------

describe('Scheduler.tick', () => {
  describe('at + notify job', () => {
    it('fires, notifies, sets lastRun, and disables itself', async () => {
      const store = makeStore(atNotifyJob());
      const { notifier, calls } = makeNotifier();
      const runPrompt: PromptRunner = vi.fn();
      const cronMatches: CronMatcher = vi.fn(() => false);

      const sched = new Scheduler({ store, notifier, runPrompt, cronMatches });
      await sched.tick(FIXED_NOW);

      expect(calls).toHaveLength(1);
      expect(calls[0]).toEqual({ message: 'Time to stand up!' });

      const updated = store.get('j-at-notify');
      expect(updated?.lastRun).toBe(FIXED_NOW.toISOString());
      expect(updated?.enabled).toBe(false);
    });

    it('does not fire when the scheduled time is in the future', async () => {
      const store = makeStore(atNotifyJob({ schedule: { kind: 'at', iso: FUTURE_ISO } }));
      const { notifier, calls } = makeNotifier();
      const sched = new Scheduler({ store, notifier, runPrompt: vi.fn(), cronMatches: vi.fn(() => false) });

      await sched.tick(FIXED_NOW);

      expect(calls).toHaveLength(0);
    });

    it('does not fire again when lastRun is already set (idempotent)', async () => {
      const store = makeStore(atNotifyJob({ lastRun: PAST_ISO }));
      const { notifier, calls } = makeNotifier();
      const sched = new Scheduler({ store, notifier, runPrompt: vi.fn(), cronMatches: vi.fn(() => false) });

      await sched.tick(FIXED_NOW);

      expect(calls).toHaveLength(0);
    });
  });

  describe('at + prompt job', () => {
    it('calls runPrompt and notifies the reply with title "Saoirse"', async () => {
      const store = makeStore(atPromptJob());
      const { notifier, calls } = makeNotifier();
      const runPrompt: PromptRunner = vi.fn(async () => 'Here are your todos.');
      const sched = new Scheduler({ store, notifier, runPrompt, cronMatches: vi.fn(() => false) });

      await sched.tick(FIXED_NOW);

      expect(runPrompt).toHaveBeenCalledWith('Summarise my todos');
      expect(calls).toHaveLength(1);
      expect(calls[0]).toEqual({ title: 'Saoirse', message: 'Here are your todos.' });

      const updated = store.get('j-at-prompt');
      expect(updated?.enabled).toBe(false);
      expect(updated?.lastRun).toBe(FIXED_NOW.toISOString());
    });
  });

  describe('cron job', () => {
    it('fires when cronMatches returns true and no lastRun', async () => {
      const store = makeStore(cronNotifyJob());
      const { notifier, calls } = makeNotifier();
      const sched = new Scheduler({ store, notifier, runPrompt: vi.fn(), cronMatches: () => true });

      await sched.tick(FIXED_NOW);

      expect(calls).toHaveLength(1);
      // Cron jobs remain enabled after firing.
      expect(store.get('j-cron')?.enabled).toBe(true);
      expect(store.get('j-cron')?.lastRun).toBe(FIXED_NOW.toISOString());
    });

    it('does not fire when cronMatches returns false', async () => {
      const store = makeStore(cronNotifyJob());
      const { notifier, calls } = makeNotifier();
      const sched = new Scheduler({ store, notifier, runPrompt: vi.fn(), cronMatches: () => false });

      await sched.tick(FIXED_NOW);

      expect(calls).toHaveLength(0);
    });

    it('does not double-fire within the same minute', async () => {
      // lastRun is set to exactly FIXED_NOW — same minute bucket, no re-fire.
      const sameMinuteLastRun = FIXED_NOW.toISOString();
      const store = makeStore(cronNotifyJob({ lastRun: sameMinuteLastRun }));
      const { notifier, calls } = makeNotifier();
      const sched = new Scheduler({ store, notifier, runPrompt: vi.fn(), cronMatches: () => true });

      await sched.tick(FIXED_NOW);

      expect(calls).toHaveLength(0);
    });

    it('fires again in a later minute even when lastRun is set', async () => {
      // lastRun is one minute before FIXED_NOW.
      const priorMinute = new Date(FIXED_NOW.getTime() - 60_000).toISOString();
      const store = makeStore(cronNotifyJob({ lastRun: priorMinute }));
      const { notifier, calls } = makeNotifier();
      const sched = new Scheduler({ store, notifier, runPrompt: vi.fn(), cronMatches: () => true });

      await sched.tick(FIXED_NOW);

      expect(calls).toHaveLength(1);
    });
  });

  describe('disabled jobs', () => {
    it('skips a job with enabled=false', async () => {
      const store = makeStore(atNotifyJob({ enabled: false }));
      const { notifier, calls } = makeNotifier();
      const sched = new Scheduler({ store, notifier, runPrompt: vi.fn(), cronMatches: vi.fn(() => false) });

      await sched.tick(FIXED_NOW);

      expect(calls).toHaveLength(0);
    });
  });

  describe('error isolation', () => {
    it('a failing job does not prevent subsequent due jobs from firing', async () => {
      const throwingJob = atNotifyJob({ id: 'bad', action: { type: 'notify', text: 'boom' } });
      const goodJob = atNotifyJob({ id: 'good', action: { type: 'notify', text: 'ok' } });

      const store = makeStore(throwingJob, goodJob);

      // notifier throws on the first call, succeeds on the second.
      const notifier: Notifier = {
        notify: vi.fn()
          .mockRejectedValueOnce(new Error('ntfy unreachable'))
          .mockResolvedValueOnce(undefined),
      };

      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const sched = new Scheduler({ store, notifier, runPrompt: vi.fn(), cronMatches: vi.fn(() => false) });

      await sched.tick(FIXED_NOW);

      expect(notifier.notify).toHaveBeenCalledTimes(2);
      // 'bad' failed — lastRun should NOT be set (retry semantics).
      expect(store.get('bad')?.lastRun).toBeUndefined();
      // 'good' succeeded — lastRun IS set.
      expect(store.get('good')?.lastRun).toBe(FIXED_NOW.toISOString());
      expect(errSpy).toHaveBeenCalled();

      errSpy.mockRestore();
    });
  });
});
