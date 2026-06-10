import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Engram pulls in better-sqlite3 (a native addon), which requires forked
    // child processes rather than worker_threads (the vitest default). Mirror
    // engram's own config so any test that touches the real Memory wrapper works.
    pool: 'forks',
    restoreMocks: true,
    unstubGlobals: true,
  },
});
