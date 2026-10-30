// The four DR patterns from AWS's "Disaster Recovery of Workloads on AWS",
// as a trade between monthly cost and how fast and how fresh you come back.
// Figures are illustrative, chosen to keep the patterns in the order the
// whitepaper describes (backup and restore cheapest and slowest, multi-site
// active/active most costly and nearest zero). The second event is the one the
// whitepaper warns about: replication copies corruption as faithfully as data.

export type Pattern = 'backup' | 'pilot' | 'warm' | 'active';
export type Scenario = 'wiki' | 'shop' | 'payments';
export type DrEvent = 'region' | 'corruption';

export const PATTERNS: Record<Pattern, { label: string; rtoMin: number; rpoMin: number; cost: number; what: string }> = {
  backup: { label: 'Backup and restore', rtoMin: 8 * 60, rpoMin: 24 * 60, cost: 300, what: 'Nightly backups copied to another region. Recovery means rebuilding everything from code and restoring the data.' },
  pilot: { label: 'Pilot light', rtoMin: 60, rpoMin: 5, cost: 1200, what: 'Data replicated continuously; app servers defined but switched off until needed.' },
  warm: { label: 'Warm standby', rtoMin: 10, rpoMin: 1, cost: 3000, what: 'A smaller copy of production always running in the other region. Scale it up and switch.' },
  active: { label: 'Multi-site active/active', rtoMin: 1, rpoMin: 0, cost: 7000, what: 'Both regions serve users all the time. Losing one shifts its traffic to the other.' },
};

/** Point-in-time backups: restore the database to any five-minute mark. */
export const PITR = { cost: 150, rpoMin: 5, restoreMin: 90 };

export const SCENARIOS: Record<Scenario, { label: string; rtoMin: number; rpoMin: number }> = {
  wiki: { label: 'Internal wiki', rtoMin: 24 * 60, rpoMin: 24 * 60 },
  shop: { label: 'Online shop', rtoMin: 120, rpoMin: 15 },
  payments: { label: 'Payment service', rtoMin: 15, rpoMin: 1 },
};

export type DrResult = {
  scenario: Scenario; pattern: Pattern; pitr: boolean; event: DrEvent;
  rtoMin: number; rpoMin: number; met: boolean; cost: number; cheapestPattern: boolean; note: string;
};

export function cheapestPatternFor(s: Scenario): Pattern | undefined {
  const t = SCENARIOS[s];
  return (Object.keys(PATTERNS) as Pattern[])
    .filter((p) => PATTERNS[p].rtoMin <= t.rtoMin && PATTERNS[p].rpoMin <= t.rpoMin)
    .sort((a, b) => PATTERNS[a].cost - PATTERNS[b].cost)[0];
}

export function drill(scenario: Scenario, pattern: Pattern, pitr: boolean, event: DrEvent): DrResult {
  const p = PATTERNS[pattern], t = SCENARIOS[scenario];
  let rtoMin = p.rtoMin, rpoMin = p.rpoMin, note: string;
  if (event === 'region') {
    note = `The primary region is gone. ${p.label}: back in ${fmtMin(rtoMin)}, losing ${rpoMin ? `up to ${fmtMin(rpoMin)} of data` : 'almost nothing'}.`;
  } else if (pattern === 'backup') {
    // Its backups are point-in-time copies already; PITR only makes them finer.
    rpoMin = pitr ? PITR.rpoMin : p.rpoMin;
    note = `A bad deploy wrote garbage into the orders table. Restore the database from before it: back in ${fmtMin(rtoMin)}, losing up to ${fmtMin(rpoMin)}.`;
  } else if (pitr) {
    rtoMin = PITR.restoreMin; rpoMin = PITR.rpoMin;
    note = `Replication copied the garbage to the other region within seconds, so failing over does not help. A point-in-time restore to just before the deploy does: ${fmtMin(rtoMin)}, losing up to ${fmtMin(rpoMin)}.`;
  } else {
    rtoMin = Infinity; rpoMin = Infinity;
    note = 'Replication copied the garbage to the other region within seconds. Both copies are corrupt and there is no point-in-time backup to go back to.';
  }
  const met = rtoMin <= t.rtoMin && rpoMin <= t.rpoMin;
  return { scenario, pattern, pitr, event, rtoMin, rpoMin, met, cost: p.cost + (pitr ? PITR.cost : 0), cheapestPattern: pattern === cheapestPatternFor(scenario), note };
}

export function fmtMin(min: number): string {
  if (!Number.isFinite(min)) return 'never';
  if (min === 0) return 'seconds';
  if (min < 60) return `${min} min`;
  if (min < 24 * 60) return `${+(min / 60).toFixed(1)} h`;
  return `${+(min / 1440).toFixed(1)} d`;
}
