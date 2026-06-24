// =============================================================================
// job-store.ts — FileJobStore: JSON-backed persistence for scheduled jobs.
//
// The seam: JobStore is an interface defined in jobs.ts so the scheduler has
// no compile-time dependency on the file system. FileJobStore is the first
// (and currently only) implementation; a future in-memory or SQLite store
// can drop in without touching the scheduler.
//
// Persistence strategy: an in-memory array is the live source of truth.
// Every mutation is mirrored to disk synchronously (writeFileSync) so a crash
// after a successful add/update/remove never leaves the file and memory
// diverged. Pretty-JSON makes the file human-readable for debugging.
// =============================================================================

import { readFileSync, writeFileSync } from 'node:fs';
import type { Job, JobStore } from './jobs.js';

export class FileJobStore implements JobStore {
  private jobs: Job[];

  constructor(private readonly path: string) {
    this.jobs = FileJobStore.load(path);
  }

  private static load(path: string): Job[] {
    try {
      const raw = readFileSync(path, 'utf8');
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        console.warn('[job-store] file did not contain an array — starting empty:', path);
        return [];
      }
      return parsed as Job[];
    } catch (err: unknown) {
      // Missing file (ENOENT) is normal on first boot; anything else is worth a warn.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('[job-store] could not parse jobs file — starting empty:', path, err);
      }
      return [];
    }
  }

  private persist(): void {
    writeFileSync(this.path, JSON.stringify(this.jobs, null, 2), 'utf8');
  }

  list(): Job[] {
    return [...this.jobs];
  }

  get(id: string): Job | undefined {
    return this.jobs.find((j) => j.id === id);
  }

  add(job: Job): void {
    this.jobs.push(job);
    this.persist();
  }

  update(job: Job): void {
    const idx = this.jobs.findIndex((j) => j.id === job.id);
    if (idx !== -1) {
      this.jobs[idx] = job;
      this.persist();
    }
  }

  remove(id: string): boolean {
    const before = this.jobs.length;
    this.jobs = this.jobs.filter((j) => j.id !== id);
    if (this.jobs.length !== before) {
      this.persist();
      return true;
    }
    return false;
  }
}
