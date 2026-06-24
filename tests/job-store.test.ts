// Unit tests for FileJobStore.
//
// Each test gets a fresh temp file path so tests are isolated and never share
// state. The "reload from disk" tests construct a second FileJobStore against
// the same path, proving that mutations written by the first instance are read
// back correctly by a fresh instance (i.e. persistence round-trips cleanly).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, existsSync, writeFileSync } from 'node:fs';
import { FileJobStore } from '../src/core/job-store.js';
import type { Job } from '../src/core/jobs.js';

function tmpPath(): string {
  return join(tmpdir(), `saoirse-job-store-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

function makeJob(id: string, overrides: Partial<Job> = {}): Job {
  return {
    id,
    schedule: { kind: 'at', iso: '2026-07-01T00:00:00.000Z' },
    action: { type: 'notify', text: `Hello from ${id}` },
    enabled: true,
    createdAt: '2026-06-24T00:00:00.000Z',
    ...overrides,
  };
}

describe('FileJobStore', () => {
  let path: string;

  beforeEach(() => {
    path = tmpPath();
  });

  afterEach(() => {
    if (existsSync(path)) rmSync(path);
  });

  describe('boot behaviour', () => {
    it('starts empty when the file does not exist', () => {
      const store = new FileJobStore(path);
      expect(store.list()).toEqual([]);
    });

    it('starts empty and warns when the file is malformed JSON', () => {
      writeFileSync(path, '{ not valid json }', 'utf8');
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const store = new FileJobStore(path);
      expect(store.list()).toEqual([]);
      expect(warn).toHaveBeenCalled();

      warn.mockRestore();
    });

    it('starts empty and warns when the file contains non-array JSON', () => {
      writeFileSync(path, JSON.stringify({ not: 'an array' }), 'utf8');
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const store = new FileJobStore(path);
      expect(store.list()).toEqual([]);
      expect(warn).toHaveBeenCalled();

      warn.mockRestore();
    });

    it('loads existing jobs from disk on construction', () => {
      const jobs = [makeJob('a'), makeJob('b')];
      writeFileSync(path, JSON.stringify(jobs, null, 2), 'utf8');

      const store = new FileJobStore(path);
      expect(store.list()).toHaveLength(2);
      expect(store.get('a')).toMatchObject({ id: 'a' });
    });
  });

  describe('add', () => {
    it('adds a job and makes it visible via list and get', () => {
      const store = new FileJobStore(path);
      const job = makeJob('j1');
      store.add(job);

      expect(store.list()).toHaveLength(1);
      expect(store.get('j1')).toEqual(job);
    });

    it('persists to disk so a fresh store instance sees the added job', () => {
      const store = new FileJobStore(path);
      store.add(makeJob('j1'));

      const reload = new FileJobStore(path);
      expect(reload.get('j1')).toBeDefined();
    });
  });

  describe('update', () => {
    it('updates an existing job in memory and on disk', () => {
      const store = new FileJobStore(path);
      store.add(makeJob('j1'));

      const updated = { ...makeJob('j1'), enabled: false, lastRun: '2026-06-24T12:00:00.000Z' };
      store.update(updated);

      expect(store.get('j1')?.enabled).toBe(false);
      expect(store.get('j1')?.lastRun).toBe('2026-06-24T12:00:00.000Z');

      const reload = new FileJobStore(path);
      expect(reload.get('j1')?.enabled).toBe(false);
    });

    it('is a no-op for an id that does not exist', () => {
      const store = new FileJobStore(path);
      store.add(makeJob('j1'));
      // Should not throw.
      store.update(makeJob('unknown'));
      expect(store.list()).toHaveLength(1);
    });
  });

  describe('remove', () => {
    it('removes an existing job and returns true', () => {
      const store = new FileJobStore(path);
      store.add(makeJob('j1'));

      const result = store.remove('j1');

      expect(result).toBe(true);
      expect(store.get('j1')).toBeUndefined();
      expect(store.list()).toHaveLength(0);
    });

    it('persists the removal so a fresh store no longer sees the job', () => {
      const store = new FileJobStore(path);
      store.add(makeJob('j1'));
      store.remove('j1');

      const reload = new FileJobStore(path);
      expect(reload.list()).toHaveLength(0);
    });

    it('returns false for an id that does not exist', () => {
      const store = new FileJobStore(path);
      expect(store.remove('nonexistent')).toBe(false);
    });

    it('removes only the targeted job, leaving others intact', () => {
      const store = new FileJobStore(path);
      store.add(makeJob('j1'));
      store.add(makeJob('j2'));
      store.remove('j1');

      expect(store.list()).toHaveLength(1);
      expect(store.get('j2')).toBeDefined();
    });
  });

  describe('list', () => {
    it('returns a copy — mutating the result does not affect the store', () => {
      const store = new FileJobStore(path);
      store.add(makeJob('j1'));

      const listed = store.list();
      listed.pop();

      expect(store.list()).toHaveLength(1);
    });
  });
});
