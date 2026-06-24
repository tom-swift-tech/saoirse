// =============================================================================
// cron.ts — dependency-free 5-field cron matcher (minute granularity).
//
// Field order (space-separated):
//   minute  hour  day-of-month  month  day-of-week
//   0-59    0-23  1-31          1-12   0-7  (0 and 7 both = Sunday)
//
// Per-field syntax:
//   *        — any value
//   n        — exact integer
//   a-b      — inclusive range
//   a,b,c    — comma-separated list (each element may itself be a range or step)
//   */n      — step over full range
//   a-b/n    — step over range a..b
//
// Satisfies the CronMatcher type exported from jobs.ts.
// =============================================================================

/** Expand a single cron field token into a Set of matching integers.
 *  `min` and `max` are the allowed range for this field. */
function expandField(token: string, min: number, max: number): Set<number> {
  // Comma-separated list — expand each part and union them.
  if (token.includes(',')) {
    const result = new Set<number>();
    for (const part of token.split(',')) {
      for (const v of expandField(part.trim(), min, max)) {
        result.add(v);
      }
    }
    return result;
  }

  // Step syntax: `*/n` or `a-b/n`
  if (token.includes('/')) {
    const [rangePart, stepStr] = token.split('/');
    const step = parseInt(stepStr, 10);
    if (isNaN(step) || step < 1) {
      throw new Error(`Invalid step in cron field: "${token}"`);
    }
    let rangeMin = min;
    let rangeMax = max;
    if (rangePart !== '*') {
      const bounds = parseRange(rangePart, min, max);
      rangeMin = bounds[0];
      rangeMax = bounds[1];
    }
    const result = new Set<number>();
    for (let v = rangeMin; v <= rangeMax; v += step) {
      result.add(v);
    }
    return result;
  }

  // Wildcard
  if (token === '*') {
    const result = new Set<number>();
    for (let v = min; v <= max; v++) result.add(v);
    return result;
  }

  // Range `a-b`
  if (token.includes('-')) {
    const [lo, hi] = parseRange(token, min, max);
    const result = new Set<number>();
    for (let v = lo; v <= hi; v++) result.add(v);
    return result;
  }

  // Single integer
  const n = parseInt(token, 10);
  if (isNaN(n) || n < min || n > max) {
    throw new Error(
      `Cron field value ${token} out of range [${min}-${max}]`,
    );
  }
  return new Set([n]);
}

/** Parse `a-b` into [a, b], validating against [min, max]. */
function parseRange(
  token: string,
  min: number,
  max: number,
): [number, number] {
  const parts = token.split('-');
  if (parts.length !== 2) {
    throw new Error(`Invalid cron range: "${token}"`);
  }
  const lo = parseInt(parts[0], 10);
  const hi = parseInt(parts[1], 10);
  if (isNaN(lo) || isNaN(hi) || lo < min || hi > max || lo > hi) {
    throw new Error(
      `Cron range "${token}" invalid for bounds [${min}-${max}]`,
    );
  }
  return [lo, hi];
}

/** True if `token` is exactly `*` (unrestricted wildcard). Used for the
 *  Vixie dom/dow OR-rule: when a field carries `*` it is "unrestricted". */
function isWildcard(token: string): boolean {
  return token === '*';
}

/**
 * Returns true if the 5-field cron expression matches `date` at minute
 * granularity.  Uses LOCAL time (getMinutes / getHours / getDate / getMonth /
 * getDay).
 *
 * Implements the standard Vixie-cron dom/dow OR-rule:
 *   If BOTH day-of-month AND day-of-week are restricted (neither is `*`),
 *   the date matches if EITHER field matches — not both.
 *   If only one (or neither) is restricted, all five fields must match
 *   independently.
 *
 * Throws for malformed expressions (wrong field count, out-of-range values,
 * unrecognised tokens).  Callers should treat a throw as a validation failure
 * at job-load time.
 */
export function cronMatches(expr: string, date: Date): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(
      `Cron expression must have exactly 5 fields, got ${fields.length}: "${expr}"`,
    );
  }

  const [minTok, hourTok, domTok, monTok, dowTok] = fields;

  const minutes = expandField(minTok, 0, 59);
  const hours   = expandField(hourTok, 0, 23);
  const doms    = expandField(domTok, 1, 31);
  const months  = expandField(monTok, 1, 12);
  // day-of-week: 0-7, both 0 and 7 mean Sunday.  Normalise 7 → 0 after expansion.
  const dowRaw  = expandField(dowTok, 0, 7);
  const dows    = new Set<number>();
  for (const v of dowRaw) dows.add(v === 7 ? 0 : v);

  // Extract local-time components.
  const m    = date.getMinutes();        // 0-59
  const h    = date.getHours();          // 0-23
  const dom  = date.getDate();           // 1-31
  const mon  = date.getMonth() + 1;      // 1-12 (getMonth is 0-based)
  const dow  = date.getDay();            // 0-6, 0 = Sunday

  if (!minutes.has(m) || !hours.has(h) || !months.has(mon)) {
    return false;
  }

  // Vixie dom/dow OR-rule: both restricted → either must match.
  const domRestricted = !isWildcard(domTok);
  const dowRestricted = !isWildcard(dowTok);

  if (domRestricted && dowRestricted) {
    return doms.has(dom) || dows.has(dow);
  }

  return doms.has(dom) && dows.has(dow);
}
