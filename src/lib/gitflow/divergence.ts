// A feature branch against a moving trunk, over ten working days. A model, not
// git: each day the team changes some files on trunk and you change some on your
// branch, and a merge has to reconcile every file both sides changed since the
// last time you integrated. The day-by-day lists are fixed, so the numbers the
// lesson quotes are reproducible and pinned by tests/git-strategies.test.ts.
//
// What the model leaves out on purpose: two changes to one file do not always
// conflict in real git (different lines merge cleanly), and real conflicts
// differ in size. Counting files that both sides touched is the honest upper
// bound on what you might have to read and reconcile at once.

export const DAYS = 10;

// What you change for the feature (search filters), day by day.
export const YOURS: string[][] = [
  ['search.ts', 'api.ts'], ['db.ts'], ['ui/list.tsx'], ['search.ts'], ['config.ts', 'api.ts'],
  ['styles.css'], ['ui/list.tsx'], ['db.ts', 'prices.ts'], ['search.ts'], ['ui/header.tsx'],
];

// What the rest of the team merges to trunk on the same days.
export const TRUNK: string[][] = [
  ['cart.ts'], ['api.ts'], ['db.ts'], ['ui/list.tsx'], ['auth.ts'],
  ['config.ts', 'api.ts'], ['styles.css'], ['orders.ts'], ['prices.ts', 'db.ts'], ['ui/header.tsx', 'search.ts'],
];

export type Cadence = 1 | 3 | 10;
export type Plan = { mergeEvery: Cadence; flag: boolean };
export type Merge = { day: number; conflicts: string[]; exposed: boolean };
export type Run = {
  plan: Plan;
  merges: Merge[];
  /** Most files to reconcile in any one merge - the size of the worst batch. */
  largest: number;
  total: number;
  /** Days on which users could reach the half-built feature. */
  exposedDays: number[];
};

export function simulate(plan: Plan): Run {
  const merges: Merge[] = [];
  let mine = new Set<string>(), theirs = new Set<string>();
  for (let d = 1; d <= DAYS; d++) {
    for (const f of YOURS[d - 1]) mine.add(f);
    for (const f of TRUNK[d - 1]) theirs.add(f);
    if (d % plan.mergeEvery === 0 || d === DAYS) {
      const conflicts = [...mine].filter((f) => theirs.has(f)).sort();
      // Merged before it is finished: without a flag, users can reach it.
      merges.push({ day: d, conflicts, exposed: d < DAYS && !plan.flag });
      mine = new Set(); theirs = new Set();
    }
  }
  const exposedDays: number[] = [];
  const firstExposed = merges.find((m) => m.exposed);
  if (firstExposed) for (let d = firstExposed.day; d < DAYS; d++) exposedDays.push(d);
  return {
    plan, merges,
    largest: Math.max(...merges.map((m) => m.conflicts.length)),
    total: merges.reduce((n, m) => n + m.conflicts.length, 0),
    exposedDays,
  };
}

export const CADENCE_LABEL: Record<Cadence, string> = {
  1: 'every day (short-lived branches)',
  3: 'every three days',
  10: 'once, after two weeks (long-lived branch)',
};
