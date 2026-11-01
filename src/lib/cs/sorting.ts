// The Killer Lab's logic: five sorts with every comparison counted, and McIlroy's
// adversary (his 1999 "A Killer Adversary for Quicksort"). tests/sorting.test.ts
// runs the same code through real Python and asserts the counts match exactly.
//
// Counts, never times: a count is the same on every machine, and on every run.

import type { Mission } from '../missions.ts';
import { listsort } from '../py/listsort.ts';

export type Cmp = (a: number, b: number) => number;
export type SortName = 'selection' | 'insertion' | 'merge' | 'quick' | 'python';
export type Pivot = 'first' | 'middle' | 'random' | 'median3';
export type InputName = 'sorted' | 'shuffled' | 'organ' | 'equal' | 'zeroOne' | 'adversary' | 'replay';

export const SORT_LABELS: Record<SortName, string> = {
  selection: 'Selection sort', insertion: 'Insertion sort', merge: 'Merge sort', quick: 'Quicksort', python: "Python's sorted",
};
export const PIVOT_LABELS: Record<Pivot, string> = { first: 'first item', middle: 'middle item', random: 'random item', median3: 'median of three' };

/**
 * Same generator in the tests' Python, so "seed 11" means the same pivots on both
 * sides. Python's own random module would need a port of Mersenne Twister, and the
 * lesson's point doesn't depend on the quality of the randomness. The low bits of
 * this generator are weak, hence the shift.
 */
export class Lcg {
  seed: number;
  constructor(seed: number) { this.seed = seed & 0x7fffffff; }
  next(n: number): number {
    this.seed = (Math.imul(this.seed, 1103515245) + 12345) & 0x7fffffff;
    return (this.seed >>> 8) % n;
  }
}

export function selectionSort(a: number[], cmp: Cmp) {
  for (let i = 0; i < a.length - 1; i++) {
    let m = i;
    for (let j = i + 1; j < a.length; j++) if (cmp(a[j], a[m]) < 0) m = j;
    [a[i], a[m]] = [a[m], a[i]];
  }
}

export function insertionSort(a: number[], cmp: Cmp) {
  for (let i = 1; i < a.length; i++) {
    for (let j = i; j > 0 && cmp(a[j], a[j - 1]) < 0; j--) [a[j], a[j - 1]] = [a[j - 1], a[j]];
  }
}

export function mergeSort(a: number[], cmp: Cmp) {
  const go = (lo: number, hi: number) => {
    if (hi - lo < 2) return;
    const mid = (lo + hi) >> 1;
    go(lo, mid); go(mid, hi);
    const left = a.slice(lo, mid), right = a.slice(mid, hi);
    let i = 0, j = 0, k = lo;
    while (i < left.length && j < right.length) a[k++] = cmp(right[j], left[i]) < 0 ? right[j++] : left[i++];
    while (i < left.length) a[k++] = left[i++];
    while (j < right.length) a[k++] = right[j++];
  };
  go(0, a.length);
}

// A textbook quicksort with one partition routine, so the pivot rule is the only
// thing that changes. Iterative: first-item pivots on sorted input go n deep, and
// that must show up as comparisons, not as a stack overflow in the widget.
//
// Its partition puts every item equal to the pivot on one side, so repeated numbers
// make it quadratic whichever pivot it picks. That is deliberate: it is the Berkeley
// failure Bentley and McIlroy report, and the lesson teaches it. Do not "fix" it here
// without changing the lesson's 499,500 and the test that pins it.
export function quickSort(a: number[], cmp: Cmp, pivot: Pivot, rng?: Lcg) {
  const stack: [number, number][] = [[0, a.length - 1]];
  while (stack.length) {
    const [lo, hi] = stack.pop()!;
    if (lo >= hi) continue;
    let p: number;
    if (pivot === 'first') p = lo;
    else if (pivot === 'middle') p = (lo + hi) >> 1;
    else if (pivot === 'random') p = lo + rng!.next(hi - lo + 1);
    else {
      let x = lo, y = (lo + hi) >> 1;
      const z = hi;
      if (cmp(a[x], a[y]) > 0) [x, y] = [y, x];
      if (cmp(a[y], a[z]) > 0) { y = z; if (cmp(a[x], a[y]) > 0) y = x; }
      p = y;
    }
    const pv = a[p];
    [a[p], a[hi]] = [a[hi], a[p]];
    let i = lo;
    for (let j = lo; j < hi; j++) {
      if (cmp(a[j], pv) < 0) { [a[i], a[j]] = [a[j], a[i]]; i++; }
    }
    [a[i], a[hi]] = [a[hi], a[i]];
    stack.push([lo, i - 1], [i + 1, hi]);
  }
}

export function pythonSort(a: number[], cmp: Cmp) { listsort(a, null, (x, y) => cmp(x, y) < 0); }

/**
 * McIlroy's adversary, from the appendix of his paper. Every item starts as "gas",
 * with no value yet. It only decides a value when it has to, and always so that
 * the sort learns as little as possible. It answers comparisons while the sort
 * runs, which is the whole trick: it can see what the sort asks, including the
 * effect of any random choices, without ever seeing the random numbers.
 */
export function adversary(n: number) {
  const gas = n - 1;
  const val = new Array<number>(n).fill(gas);
  let nsolid = 0, candidate = 0;
  const cmp: Cmp = (x, y) => {
    if (val[x] === gas && val[y] === gas) {
      if (x === candidate) val[x] = nsolid; else val[y] = nsolid;
      nsolid++;
    }
    if (val[x] === gas) candidate = x;
    else if (val[y] === gas) candidate = y;
    return val[x] - val[y];
  };
  return { val, cmp, gas, solid: () => nsolid };
}

export const nLgN = (n: number) => n * Math.log2(n);
/** ⌈log₂ n!⌉ exactly, by integer arithmetic. Summing floating logs could land on the wrong integer. */
export function comparisonFloor(n: number): number {
  let f = 1n;
  for (let i = 2n; i <= BigInt(n); i++) f *= i;
  return f === 1n ? 0 : (f - 1n).toString(2).length;
}

export const sortedInput = (n: number) => Array.from({ length: n }, (_, i) => i);
export const organPipe = (n: number) => Array.from({ length: n }, (_, i) => (i < n / 2 ? i : n - 1 - i));
export function shuffledInput(n: number, seed: number) {
  const a = sortedInput(n), r = new Lcg(seed);
  for (let i = n - 1; i > 0; i--) { const j = r.next(i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
/** A file of one repeated number. The value doesn't change any count: only "equal" reaches the sort. */
export const equalInput = (n: number) => new Array<number>(n).fill(7);
export function zeroOneInput(n: number, seed: number) {
  const r = new Lcg(seed);
  return Array.from({ length: n }, () => r.next(2));
}
/**
 * A fixed file by name. Shuffled and zero-one files use seed + 1000, so the file
 * stays apart from the pivots even though both come from "the seed".
 */
export function fixedInput(input: 'sorted' | 'shuffled' | 'organ' | 'equal' | 'zeroOne', n: number, seed: number): number[] {
  if (input === 'sorted') return sortedInput(n);
  if (input === 'organ') return organPipe(n);
  if (input === 'equal') return equalInput(n);
  if (input === 'zeroOne') return zeroOneInput(n, seed + 1000);
  return shuffledInput(n, seed + 1000);
}

export function runSort(sort: SortName, a: number[], cmp: Cmp, pivot: Pivot, seed: number) {
  if (sort === 'selection') selectionSort(a, cmp);
  else if (sort === 'insertion') insertionSort(a, cmp);
  else if (sort === 'merge') mergeSort(a, cmp);
  else if (sort === 'python') pythonSort(a, cmp);
  else quickSort(a, cmp, pivot, new Lcg(seed));
}

export type Config = { sort: SortName; pivot: Pivot; input: InputName; n: number; seed: number };
export type Saved = { values: number[]; n: number; sort: SortName; pivot: Pivot; seed: number };
export type SortRun = Config & {
  comparisons: number;
  /** n(n-1)/2, the most a sane sort needs. */
  worst: number;
  floor: number;
  /** Set when input is 'replay': what the saved input was built against. */
  builtAgainst?: Saved;
  /** Checked on every run: a counter on a sort that doesn't sort proves nothing. */
  ordered: boolean;
  /** How the adversary's values solidified, sampled for drawing. */
  frames?: number[][];
};

const FRAMES = 36;
const plain: Cmp = (x, y) => x - y;

export class KillerLab {
  runs: SortRun[] = [];
  saved: Saved | null = null;

  /** Returns the run, or a reason there isn't one: replaying nothing must not read as a cheap sort. */
  run(c: Config): SortRun | { refused: string } {
    const worst = c.n * (c.n - 1) / 2, floor = comparisonFloor(c.n);
    let count = 0, a: number[], cmp: Cmp, frames: number[][] | undefined, builtAgainst: Saved | undefined;
    if (c.input === 'adversary') {
      const adv = adversary(c.n);
      a = sortedInput(c.n);
      // Sampled against the quadratic worst case: a sort the adversary can't hurt
      // finishes between samples and draws fewer frames.
      frames = [[...adv.val]];
      const every = Math.max(1, Math.floor(c.n * (c.n - 1) / 2 / FRAMES));
      cmp = (x, y) => {
        count++;
        const r = adv.cmp(x, y);
        if (count % every === 0 && frames!.length < FRAMES * 2) frames!.push([...adv.val]);
        return r;
      };
      runSort(c.sort, a, cmp, c.pivot, c.seed);
      frames.push([...adv.val]);
      // Sorted indices by their final values must come out ascending, or the
      // adversary and the sort disagreed and every number here is meaningless.
      const ordered = a.every((x, i) => i === 0 || adv.val[a[i - 1]] <= adv.val[x]);
      this.saved = { values: [...adv.val], n: c.n, sort: c.sort, pivot: c.pivot, seed: c.seed };
      const r: SortRun = { ...c, comparisons: count, worst, floor, ordered, frames };
      this.runs.push(r);
      return r;
    }
    if (c.input === 'replay') {
      if (!this.saved) return { refused: 'Nothing to replay yet. Run the adversary first: it builds the input as it answers.' };
      if (this.saved.n !== c.n) return { refused: `The saved input has ${this.saved.n} items, not ${c.n}. Set n to ${this.saved.n} to replay it.` };
      a = [...this.saved.values];
      builtAgainst = this.saved;
    } else a = fixedInput(c.input, c.n, c.seed);
    cmp =(x, y) => { count++; return plain(x, y); };
    runSort(c.sort, a, cmp, c.pivot, c.seed);
    const ordered = a.every((x, i) => i === 0 || a[i - 1] <= x);
    const r: SortRun = { ...c, comparisons: count, worst, floor, ordered, builtAgainst };
    this.runs.push(r);
    return r;
  }
}

/** Thins a list for drawing. The shape reads the same at 120 points as at 2,000. */
export function sample(values: number[], points = 120): number[] {
  if (values.length <= points) return values;
  return Array.from({ length: points }, (_, i) => values[Math.floor(i * values.length / points)]);
}

export type KillerState = { lab: KillerLab };

const big = (r: SortRun) => r.n >= 500;
const quadratic = (r: SortRun) => r.comparisons >= 0.4 * r.n * r.n;
const fast = (r: SortRun) => r.comparisons <= 3 * nLgN(r.n);

export const KILLER_MISSION: Mission<KillerState> = {
  id: 'cs-killer-lab', title: 'Beat the pivot, then beat the attacker', xp: 80,
  setup: () => ({ lab: new KillerLab() }),
  steps: [
    { text: 'Make quicksort quadratic with no attacker at all, on the kindest input there is', hint: 'Quicksort, pivot: first item, input: already sorted, n at least 500, then Run', done: (s) => s.lab.runs.some((r) => big(r) && r.sort === 'quick' && r.pivot === 'first' && r.input === 'sorted' && r.comparisons === r.worst) },
    { text: 'Switch to random pivots on the same input. Does the problem go away?', hint: 'Pivot: random item, input: already sorted, then Run', done: (s) => s.lab.runs.some((r) => big(r) && r.sort === 'quick' && r.pivot === 'random' && r.input === 'sorted' && fast(r)) },
    { text: 'Now let the adversary answer the comparisons while those random pivots run', hint: 'Pivot: random item, input: the adversary, then Run', done: (s) => s.lab.runs.some((r) => big(r) && r.sort === 'quick' && r.pivot === 'random' && r.input === 'adversary' && quadratic(r)) },
    { text: 'Save what it built, and replay it as a plain file against a seed it never saw', hint: 'Input: replay the saved input, then press New seed, then Run', done: (s) => s.lab.runs.some((r) => big(r) && r.sort === 'quick' && r.pivot === 'random' && r.input === 'replay' && !!r.builtAgainst && r.builtAgainst.sort === 'quick' && r.builtAgainst.pivot === 'random' && r.seed !== r.builtAgainst.seed && fast(r)) },
    { text: 'Replay the same input with the seed it was built against: an attacker who learned your seed', hint: 'Put the seed back to the one the adversary ran with, then Run', done: (s) => s.lab.runs.some((r) => big(r) && r.sort === 'quick' && r.pivot === 'random' && r.input === 'replay' && !!r.builtAgainst && r.builtAgainst.sort === 'quick' && r.builtAgainst.pivot === 'random' && r.seed === r.builtAgainst.seed && quadratic(r)) },
    { text: 'No attacker now, and no secret to learn: give those random pivots a file of one repeated number', hint: 'Pivot: random item, input: all the same number, then Run. Try another seed too', done: (s) => s.lab.runs.some((r) => big(r) && r.sort === 'quick' && r.pivot === 'random' && r.input === 'equal' && r.comparisons === r.worst) },
    { text: "Turn the adversary on Python's sorted", hint: "Sort: Python's sorted, input: the adversary, then Run", done: (s) => s.lab.runs.some((r) => big(r) && r.sort === 'python' && r.input === 'adversary' && r.comparisons === r.n - 1) },
  ],
  debrief: "Sorted input broke a first-item pivot with nobody attacking. Random pivots fixed that for a file of different numbers: replayed against a new seed, the adversary's input is just another shuffle. But an attacker who can answer comparisons, or who knows the seed, is playing a different game, and quicksort loses it at about n²/2. McIlroy and Sedgewick's lightning are both right, about different attackers. A file of one repeated number needed no attacker and no seed, because this partition puts every item equal to the pivot on one side, so no choice of pivot helps. Real sorts split equal items evenly or group them. sorted never gave the adversary an opening, because it isn't a quicksort: the adversary's cheapest answer, \"this item is the next smallest\", looks to sorted like a run that is already in order.",
};
