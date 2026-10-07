const VALUE = { pass: 1, warn: 0.5, fail: 0 };

export const BLOCKER_CAP = 39;

/**
 * Weighted score 0-100. "info" checks and zero-weight checks do not count.
 * A failed blocker check (critical: true) caps the score at 39, because nothing
 * else matters if crawlers cannot load or index the page.
 * @param {{ status: string, weight: number, critical?: boolean }[]} checks
 */
export function scoreChecks(checks) {
  let total = 0;
  let earned = 0;
  for (const c of checks) {
    if (!(c.status in VALUE) || !c.weight) continue;
    total += c.weight;
    earned += c.weight * VALUE[c.status];
  }
  let score = total ? Math.round((earned / total) * 100) : 0;
  const blockers = checks.filter((c) => c.critical && c.status === 'fail').length;
  if (blockers) score = Math.min(score, BLOCKER_CAP);
  return { score, grade: grade(score), blockers };
}

export function grade(score) {
  if (score >= 90) return 'A';
  if (score >= 75) return 'B';
  if (score >= 60) return 'C';
  if (score >= 40) return 'D';
  return 'F';
}
