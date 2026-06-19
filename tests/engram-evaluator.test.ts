// Tier-0 unit tests: the acceptance predicate (the literal gate judgment), the
// vitest-summary parser that feeds it, and the argv-injection guards on git
// arguments. All pure — no clone, no git, no network.
import { describe, it, expect } from 'vitest';
import {
  isEngramCandidateAcceptable,
  parseTestSummary,
  assertSafeRef,
  assertSafeRepo,
} from '../src/core/engram-evaluator.js';

describe('isEngramCandidateAcceptable — the Tier-0 gate', () => {
  const baseline = 334;

  it('accepts zero failures AND at least the baseline count', () => {
    expect(
      isEngramCandidateAcceptable({ passed: 340, failed: 0, total: 340 }, baseline),
    ).toBe(true);
    // exactly the baseline is enough
    expect(
      isEngramCandidateAcceptable({ passed: 334, failed: 0, total: 334 }, baseline),
    ).toBe(true);
  });

  it('rejects any failure, even with a huge passing count', () => {
    expect(
      isEngramCandidateAcceptable({ passed: 999, failed: 1, total: 1000 }, baseline),
    ).toBe(false);
  });

  it('rejects a green-but-shrunken suite (the silent-truncation guard)', () => {
    // Zero failures, but far fewer tests ran than the known-good floor.
    expect(
      isEngramCandidateAcceptable({ passed: 10, failed: 0, total: 10 }, baseline),
    ).toBe(false);
  });

  it('rejects an empty suite even if the baseline were misconfigured to 0', () => {
    expect(isEngramCandidateAcceptable({ passed: 0, failed: 0, total: 0 }, 0)).toBe(
      false,
    );
  });
});

describe('parseTestSummary — vitest summary line', () => {
  it('parses the all-green form', () => {
    expect(parseTestSummary('Tests  334 passed (334)')).toEqual({
      passed: 334,
      failed: 0,
      total: 334,
    });
  });

  it('parses the mixed failed|passed form', () => {
    expect(parseTestSummary('Tests  2 failed | 332 passed (334)')).toEqual({
      passed: 332,
      failed: 2,
      total: 334,
    });
  });

  it('picks the last summary line out of noisy output', () => {
    const out = [
      'some build noise',
      ' Test Files  17 passed (17)',
      '      Tests  105 passed (105)',
      ' Duration  2s',
    ].join('\n');
    expect(parseTestSummary(out)).toEqual({ passed: 105, failed: 0, total: 105 });
  });

  it('returns zeroes when no summary is present (no demonstrable pass)', () => {
    expect(parseTestSummary('nothing relevant here')).toEqual({
      passed: 0,
      failed: 0,
      total: 0,
    });
  });
});

describe('git argv guards — flag smuggling', () => {
  it('accepts ordinary refs: SHAs, tags, slashed branches', () => {
    expect(() => assertSafeRef('e1b9e82a83c5d6e7182d9bd40655dc70e160c383')).not.toThrow();
    expect(() => assertSafeRef('v1.2.3')).not.toThrow();
    expect(() => assertSafeRef('feature/recall-ordering')).not.toThrow();
    expect(() => assertSafeRef('release-1.2')).not.toThrow(); // mid-ref hyphen ok
  });

  it('rejects option-shaped and metacharacter refs', () => {
    expect(() => assertSafeRef('--upload-pack=evil')).toThrow(/unsafe/);
    expect(() => assertSafeRef('-x')).toThrow(/unsafe/);
    expect(() => assertSafeRef('a; rm -rf /')).toThrow(/unsafe/);
    expect(() => assertSafeRef('')).toThrow(/unsafe/);
  });

  it('only accepts http(s) clone sources', () => {
    expect(() => assertSafeRepo('https://github.com/x/engram.git')).not.toThrow();
    expect(() => assertSafeRepo('--foo')).toThrow(/unsafe/);
    expect(() => assertSafeRepo('file:///etc')).toThrow(/unsafe/);
  });
});
