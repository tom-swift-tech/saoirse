// tests/cron.test.ts — thorough coverage for the 5-field cron matcher.
//
// Date construction: new Date(year, monthIndex, day, hour, min)
//   monthIndex is 0-based; getMonth()+1 maps it back to 1-based.
//   e.g. new Date(2024, 0, 1, 0, 0)  → 2024-01-01 00:00 (January)
//        new Date(2024, 11, 31, 23, 59) → 2024-12-31 23:59 (December)

import { describe, it, expect } from 'vitest';
import { cronMatches } from '../src/core/cron.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Monday 2024-01-08 09:30 local */
const MON_0108_0930 = new Date(2024, 0, 8, 9, 30);
/** Sunday 2024-01-07 00:00 local */
const SUN_0107_0000 = new Date(2024, 0, 7, 0, 0);
/** Wednesday 2024-03-13 15:45 local */
const WED_0313_1545 = new Date(2024, 2, 13, 15, 45);

// ---------------------------------------------------------------------------
// Wildcard
// ---------------------------------------------------------------------------

describe('* * * * * — matches any date', () => {
  it('matches a Monday morning', () => {
    expect(cronMatches('* * * * *', MON_0108_0930)).toBe(true);
  });
  it('matches a Sunday midnight', () => {
    expect(cronMatches('* * * * *', SUN_0107_0000)).toBe(true);
  });
  it('matches a random date mid-month', () => {
    expect(cronMatches('* * * * *', WED_0313_1545)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Exact minute / hour
// ---------------------------------------------------------------------------

describe('exact minute and hour', () => {
  it('matches when both minute and hour are exact', () => {
    // 09:30 on a Monday
    expect(cronMatches('30 9 * * *', MON_0108_0930)).toBe(true);
  });
  it('does not match wrong minute', () => {
    expect(cronMatches('0 9 * * *', MON_0108_0930)).toBe(false);
  });
  it('does not match wrong hour', () => {
    expect(cronMatches('30 10 * * *', MON_0108_0930)).toBe(false);
  });
  it('matches midnight exactly', () => {
    expect(cronMatches('0 0 * * *', SUN_0107_0000)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Ranges
// ---------------------------------------------------------------------------

describe('ranges (a-b)', () => {
  it('matches minute within range', () => {
    // minute 30 is in 20-40
    expect(cronMatches('20-40 9 * * *', MON_0108_0930)).toBe(true);
  });
  it('does not match minute outside range', () => {
    expect(cronMatches('31-59 9 * * *', MON_0108_0930)).toBe(false);
  });
  it('matches hour within range', () => {
    // hour 9 is in 8-17
    expect(cronMatches('30 8-17 * * *', MON_0108_0930)).toBe(true);
  });
  it('does not match hour outside range', () => {
    expect(cronMatches('30 10-23 * * *', MON_0108_0930)).toBe(false);
  });
  it('matches month within range', () => {
    // March = month 3, range 1-6
    expect(cronMatches('45 15 * 1-6 *', WED_0313_1545)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

describe('lists (a,b,c)', () => {
  it('matches minute in list', () => {
    // minute 30 in 0,15,30,45
    expect(cronMatches('0,15,30,45 9 * * *', MON_0108_0930)).toBe(true);
  });
  it('does not match minute not in list', () => {
    expect(cronMatches('0,15,45 9 * * *', MON_0108_0930)).toBe(false);
  });
  it('matches hour in list', () => {
    expect(cronMatches('30 7,9,12 * * *', MON_0108_0930)).toBe(true);
  });
  it('does not match hour not in list', () => {
    expect(cronMatches('30 8,10,12 * * *', MON_0108_0930)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

describe('steps (*/n and a-b/n)', () => {
  it('*/15 on minute matches 0, 15, 30, 45', () => {
    expect(cronMatches('*/15 * * * *', new Date(2024, 0, 1, 0, 0))).toBe(true);
    expect(cronMatches('*/15 * * * *', new Date(2024, 0, 1, 0, 15))).toBe(true);
    expect(cronMatches('*/15 * * * *', new Date(2024, 0, 1, 0, 30))).toBe(true);
    expect(cronMatches('*/15 * * * *', new Date(2024, 0, 1, 0, 45))).toBe(true);
  });
  it('*/15 on minute does NOT match 1, 14, 16, 29, 31, 44, 46', () => {
    for (const m of [1, 14, 16, 29, 31, 44, 46]) {
      expect(cronMatches('*/15 * * * *', new Date(2024, 0, 1, 0, m))).toBe(false);
    }
  });
  it('0-30/10 matches 0, 10, 20, 30 but not 40 or 50', () => {
    for (const m of [0, 10, 20, 30]) {
      expect(cronMatches(`${m} * * * *`, new Date(2024, 0, 1, 6, m))).toBe(true);
    }
    // 0-30/10 step: only within 0-30
    expect(cronMatches('0-30/10 6 * * *', new Date(2024, 0, 1, 6, 40))).toBe(false);
    expect(cronMatches('0-30/10 6 * * *', new Date(2024, 0, 1, 6, 50))).toBe(false);
  });
  it('*/6 on hour matches 0, 6, 12, 18', () => {
    for (const h of [0, 6, 12, 18]) {
      expect(cronMatches('0 */6 * * *', new Date(2024, 0, 1, h, 0))).toBe(true);
    }
    expect(cronMatches('0 */6 * * *', new Date(2024, 0, 1, 7, 0))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Month field
// ---------------------------------------------------------------------------

describe('month field', () => {
  it('matches the correct month', () => {
    // March = month 3
    expect(cronMatches('45 15 * 3 *', WED_0313_1545)).toBe(true);
  });
  it('does not match a different month', () => {
    expect(cronMatches('45 15 * 4 *', WED_0313_1545)).toBe(false);
  });
  it('matches month in a list', () => {
    expect(cronMatches('45 15 * 1,3,5 *', WED_0313_1545)).toBe(true);
  });
  it('matches month in a range', () => {
    expect(cronMatches('0 0 * 12 *', new Date(2024, 11, 25, 0, 0))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Day-of-week field
// ---------------------------------------------------------------------------

describe('day-of-week field', () => {
  it('matches Monday (dow=1)', () => {
    // MON_0108_0930 is a Monday
    expect(cronMatches('30 9 * * 1', MON_0108_0930)).toBe(true);
  });
  it('does not match Tuesday on a Monday', () => {
    expect(cronMatches('30 9 * * 2', MON_0108_0930)).toBe(false);
  });
  it('matches Sunday via 0', () => {
    // SUN_0107_0000: getDay() == 0
    expect(cronMatches('0 0 * * 0', SUN_0107_0000)).toBe(true);
  });
  it('matches Sunday via 7 (both 0 and 7 = Sunday)', () => {
    expect(cronMatches('0 0 * * 7', SUN_0107_0000)).toBe(true);
  });
  it('does not match a weekday on Sunday', () => {
    expect(cronMatches('0 0 * * 1', SUN_0107_0000)).toBe(false);
  });
  it('matches dow in list', () => {
    // Monday = 1, list includes 1
    expect(cronMatches('30 9 * * 0,1,6', MON_0108_0930)).toBe(true);
  });
  it('matches dow in range Mon-Fri (1-5)', () => {
    expect(cronMatches('30 9 * * 1-5', MON_0108_0930)).toBe(true);
  });
  it('does not match Sunday in Mon-Fri range', () => {
    expect(cronMatches('0 0 * * 1-5', SUN_0107_0000)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// dom/dow OR-rule (Vixie cron)
// ---------------------------------------------------------------------------

describe('dom/dow OR-rule: both restricted → either must match', () => {
  // `0 0 1 * 1` — fires at midnight on the 1st of the month OR on any Monday.
  // Both dom and dow are restricted (neither is `*`).

  it('matches when dom matches but dow does not', () => {
    // 2024-01-01 is a Monday, but let's use 2024-03-01 which is a Friday (dow=5)
    const fri_mar01 = new Date(2024, 2, 1, 0, 0); // March 1 2024, Friday
    expect(fri_mar01.getDay()).toBe(5); // sanity check
    expect(cronMatches('0 0 1 * 1', fri_mar01)).toBe(true); // dom=1 matches
  });

  it('matches when dow matches but dom does not', () => {
    // 2024-01-08 is a Monday (dom=8, not 1); minute=30 hour=9
    expect(MON_0108_0930.getDate()).toBe(8); // sanity check
    expect(cronMatches('30 9 1 * 1', MON_0108_0930)).toBe(true); // dow=1 matches
  });

  it('matches when both dom and dow match', () => {
    // 2024-01-01 00:00 — January 1 is a Monday
    const mon_jan01 = new Date(2024, 0, 1, 0, 0);
    expect(mon_jan01.getDay()).toBe(1); // sanity check: Monday
    expect(cronMatches('0 0 1 * 1', mon_jan01)).toBe(true);
  });

  it('does not match when neither dom nor dow matches', () => {
    // 2024-03-13 is a Wednesday (dow=3), dom=13
    expect(cronMatches('0 0 1 * 1', new Date(2024, 2, 13, 0, 0))).toBe(false);
  });

  it('uses AND (not OR) when dom is wildcard and dow is restricted', () => {
    // `0 0 * * 1` — only restricted by dow; dom is `*`
    // On a non-Monday, should not match
    expect(cronMatches('0 0 * * 1', SUN_0107_0000)).toBe(false);
    // On a Monday, should match
    expect(cronMatches('0 0 * * 1', new Date(2024, 0, 8, 0, 0))).toBe(true);
  });

  it('uses AND when dow is wildcard and dom is restricted', () => {
    // `0 0 1 * *` — only restricted by dom
    expect(cronMatches('0 0 1 * *', new Date(2024, 2, 1, 0, 0))).toBe(true);
    expect(cronMatches('0 0 1 * *', new Date(2024, 2, 13, 0, 0))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Malformed expressions — must throw
// ---------------------------------------------------------------------------

describe('malformed expressions throw', () => {
  it('throws on 4 fields', () => {
    expect(() => cronMatches('* * * *', new Date())).toThrow();
  });
  it('throws on 6 fields', () => {
    expect(() => cronMatches('* * * * * *', new Date())).toThrow();
  });
  it('throws on empty string', () => {
    expect(() => cronMatches('', new Date())).toThrow();
  });
  it('throws on minute = 60 (out of range)', () => {
    expect(() => cronMatches('60 * * * *', new Date())).toThrow();
  });
  it('throws on minute = -1 (negative)', () => {
    expect(() => cronMatches('-1 * * * *', new Date())).toThrow();
  });
  it('throws on hour = 24 (out of range)', () => {
    expect(() => cronMatches('0 24 * * *', new Date())).toThrow();
  });
  it('throws on month = 0 (out of range)', () => {
    expect(() => cronMatches('0 0 1 0 *', new Date())).toThrow();
  });
  it('throws on month = 13 (out of range)', () => {
    expect(() => cronMatches('0 0 1 13 *', new Date())).toThrow();
  });
  it('throws on alphabetic garbage in a field', () => {
    expect(() => cronMatches('abc * * * *', new Date())).toThrow();
  });
  it('throws on step of zero', () => {
    expect(() => cronMatches('*/0 * * * *', new Date())).toThrow();
  });
  it('throws on inverted range (a > b)', () => {
    expect(() => cronMatches('30-10 * * * *', new Date())).toThrow();
  });
});
