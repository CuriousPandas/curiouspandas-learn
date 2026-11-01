// The Fairness Lab's arithmetic, with no DOM. Two invented groups of people, each
// scored from 1 to 10 for a review, and a threshold per group. The point of the
// lab is Chouldechova's equation (2.6): prevalence, predictive value and the two
// error rates are tied together, so they can't all be set freely.

export type Level = { people: number; wrong: number };
export type Group = { name: string; levels: Level[] };
export type Dataset = { id: string; label: string; a: Group; b: Group };

// One chance per score, the same for both groups, so a given score means the same
// thing whoever holds it. Counts are multiples of 20 so that every "wrong" count
// is a whole person: a rounded count would break the exact checks in the tests.
export const CHANCE = [0.05, 0.15, 0.25, 0.35, 0.45, 0.55, 0.65, 0.75, 0.85, 0.95];
const group = (name: string, people: number[]): Group => ({
  name, levels: people.map((n, i) => ({ people: n, wrong: Math.round(n * CHANCE[i]) })),
});

export const DATASETS: Dataset[] = [
  { id: 'different', label: 'Different base rates (invented)', a: group('Group A', [200, 180, 160, 140, 100, 80, 60, 40, 20, 20]), b: group('Group B', [20, 40, 60, 80, 100, 140, 160, 180, 100, 120]) },
  { id: 'same', label: 'Same base rates (identical groups)', a: group('Group A', [100, 100, 100, 100, 100, 100, 100, 100, 100, 100]), b: group('Group B', [100, 100, 100, 100, 100, 100, 100, 100, 100, 100]) },
];

export type Rates = {
  people: number; wrong: number; flagged: number; flaggedWrong: number;
  /** Share of people whose claim really was wrong: the base rate. */
  base: number;
  /** Of the people whose claim was fine, the share flagged anyway. */
  fpr: number;
  /** Of the people whose claim was wrong, the share not flagged. */
  fnr: number;
  /** Of the people flagged, the share really wrong. Null when nobody was flagged: undefined, not zero. */
  ppv: number | null;
  /** Innocent people investigated, the human count behind fpr. */
  wronglyFlagged: number;
};

/** Everyone at this score or above is flagged. A threshold of 11 flags nobody. */
export function rates(g: Group, threshold: number): Rates {
  let people = 0, wrong = 0, flagged = 0, flaggedWrong = 0;
  g.levels.forEach((l, i) => {
    people += l.people;
    wrong += l.wrong;
    if (i + 1 >= threshold) { flagged += l.people; flaggedWrong += l.wrong; }
  });
  const fine = people - wrong, wronglyFlagged = flagged - flaggedWrong;
  return {
    people, wrong, flagged, flaggedWrong, wronglyFlagged, base: wrong / people,
    fpr: fine ? wronglyFlagged / fine : 0,
    fnr: wrong ? (wrong - flaggedWrong) / wrong : 0,
    ppv: flagged ? flaggedWrong / flagged : null,
  };
}

/** Chouldechova's (2.6): FPR = p/(1-p) x (1-PPV)/PPV x (1-FNR). Null when PPV is undefined. */
export function fprFromEquation(r: Pick<Rates, 'base' | 'ppv' | 'fnr'>): number | null {
  if (r.ppv === null || r.ppv === 0) return null;
  return (r.base / (1 - r.base)) * ((1 - r.ppv) / r.ppv) * (1 - r.fnr);
}

/**
 * The line under the table. With nobody flagged the equation has no predictive value
 * to work from, so it can't be said to agree with a table that shows 0.0%. It once
 * printed "undefined and undefined. It always agrees with the table."
 */
export function equationNote(a: Rates, b: Rates): string {
  const va = fprFromEquation(a), vb = fprFromEquation(b);
  if (va === null || vb === null) return 'With nobody flagged in a group there is no predictive value, so Chouldechova\'s equation has nothing to work from at these thresholds.';
  return `Chouldechova's equation, worked from the base rate, predictive value and false-negative rate above, gives false-positive rates of ${(va * 100).toFixed(1)}% and ${(vb * 100).toFixed(1)}%, the same as the table.`;
}

export const TOLERANCE = 0.02;
const close = (x: number | null, y: number | null) => x !== null && y !== null && Math.abs(x - y) <= TOLERANCE;

export type Pair = { ta: number; tb: number; fprGap: number; fnrGap: number; ppvGap: number | null; all: boolean };
export function compare(d: Dataset, ta: number, tb: number): Pair {
  const ra = rates(d.a, ta), rb = rates(d.b, tb);
  const ppvGap = ra.ppv === null || rb.ppv === null ? null : Math.abs(ra.ppv - rb.ppv);
  return { ta, tb, fprGap: Math.abs(ra.fpr - rb.fpr), fnrGap: Math.abs(ra.fnr - rb.fnr), ppvGap, all: close(ra.fpr, rb.fpr) && close(ra.fnr, rb.fnr) && close(ra.ppv, rb.ppv) };
}

/** Every pair of thresholds, 1 to 11 each. Pairs where somebody's PPV is undefined can't count as equal. */
export function search(d: Dataset): { tried: number; hits: Pair[]; closest: Pair } {
  let tried = 0, closest: Pair | null = null;
  const hits: Pair[] = [];
  const worst = (p: Pair) => Math.max(p.fprGap, p.fnrGap, p.ppvGap ?? 1);
  for (let ta = 1; ta <= 11; ta++) for (let tb = 1; tb <= 11; tb++) {
    const p = compare(d, ta, tb);
    tried++;
    if (p.all) hits.push(p);
    if (p.ppvGap !== null && (!closest || worst(p) < worst(closest))) closest = p;
  }
  return { tried, hits, closest: closest! };
}

export class FairnessLab {
  dataset = DATASETS[0];
  // Apart to begin with, so that the mission's first step takes an action.
  ta = 4;
  tb = 9;
  // Sticky: the mission shows steps in order and re-judges them on every redraw.
  sawSameScoreGap = false;
  sawFprEqualised = false;
  searched: string[] = [];
  sawAllEqual = false;

  constructor() { this.note(); }

  private note() {
    const ra = rates(this.dataset.a, this.ta), rb = rates(this.dataset.b, this.tb);
    if (this.dataset.id === 'different') {
      if (this.ta === this.tb && Math.abs(ra.fpr - rb.fpr) > 0.1 && ra.flagged > 0 && rb.flagged > 0 && ra.flagged < ra.people && rb.flagged < rb.people) this.sawSameScoreGap = true;
      // Flag-everyone and flag-nobody make the error rates match by making them
      // useless, so the rate has to be equal somewhere in between.
      if (close(ra.fpr, rb.fpr) && ra.fpr > 0.03 && ra.fpr < 0.97 && this.ta !== this.tb) this.sawFprEqualised = true;
    }
    // The same rule as above. Without it, flagging everyone counted as making all
    // three match, which is the shortcut this mission's header says it refuses.
    // Flagging nobody can't get here: its predictive value is undefined, not equal.
    if (compare(this.dataset, this.ta, this.tb).all && this.dataset.id === 'same' && ra.flagged < ra.people && rb.flagged < rb.people) this.sawAllEqual = true;
  }

  set(ta: number, tb: number) { this.ta = ta; this.tb = tb; this.note(); }
  use(id: string) {
    this.dataset = DATASETS.find((d) => d.id === id) ?? this.dataset;
    this.note();
  }
  runSearch() {
    const r = search(this.dataset);
    if (!this.searched.includes(this.dataset.id)) this.searched.push(this.dataset.id);
    return r;
  }
}
