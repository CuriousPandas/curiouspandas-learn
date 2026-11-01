// The Layout Lab's logic: a small cache model, CPython's list growth rule, and
// the shuffled walk the "your machine" panel times. Pure, so a test can hold the
// model against an independent reference and the growth rule against sys.getsizeof.
//
// None of this is Python, on purpose. A Python list holds pointers to objects that
// can live anywhere, so a list can't show what contiguity buys. Python's array module
// can lay values side by side, but about 70 ns of interpreter work per step drowns
// most of the effect: measured at about 2x where this walk shows over 40x.

import type { Mission } from '../missions.ts';

// A model, with its sizes on the label. Real caches have several levels and are
// far bigger. These sizes make the tipping point reachable with a slider and
// visible on a phone: scaled up, the same arithmetic gives the same shape.
export const LINE_WORDS = 8;
export const CACHE_LINES = 16;
export const CACHE_WORDS = LINE_WORDS * CACHE_LINES;
// A node needs room for its value and for the address of the next node, so a
// linked list is twice the size of the array before layout even comes into it.
export const NODE_WORDS = 2;
// Norvig's round numbers, "fetch from L1 cache memory 0.5 nanosec" and "fetch
// from main memory 100 nanosec". The model's time is only ever labelled as these.
export const HIT_NS = 0.5;
export const MISS_NS = 100;

export const MIN_SIZE = 8;
export const MAX_SIZE = 1024;
export const SIZE_STEP = 8;

export type Walk = 'array' | 'list-ordered' | 'list-shuffled';
export const WALKS: { id: Walk; label: string }[] = [
  { id: 'array', label: 'array: values side by side' },
  { id: 'list-ordered', label: 'linked list: nodes in memory order' },
  { id: 'list-shuffled', label: 'linked list: nodes scattered' },
];

// A small seeded generator (mulberry32), so a walk is the same on every machine
// and a test can assert exact counts. Math.random would make that impossible.
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * next[i] is the node after i, as one cycle through every node (Sattolo's
 * algorithm). A plain shuffle can split into several small cycles, and a walk
 * would then loop inside a tiny corner of memory while appearing to visit it all.
 */
export function makeCycle(n: number, seed: number): Int32Array {
  const order = new Int32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  const r = rng(seed);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(r() * i);
    const t = order[i]; order[i] = order[j]; order[j] = t;
  }
  const next = new Int32Array(n);
  for (let i = 0; i < n; i++) next[order[i]] = order[(i + 1) % n];
  return next;
}

export function makeInOrder(n: number): Int32Array {
  const next = new Int32Array(n);
  for (let i = 0; i < n; i++) next[i] = (i + 1) % n;
  return next;
}

/** Follows next for `steps` hops and returns where it ended. Returning it is what stops an engine deleting the walk as useless. */
export function chase(next: Int32Array, start: number, steps: number): number {
  let at = start;
  for (let i = 0; i < steps; i++) at = next[at];
  return at;
}

/** The word address read at each step. One read per element: the walks differ in where, never in how many. */
export function addresses(walk: Walk, n: number, seed = 1): number[] {
  if (walk === 'array') return Array.from({ length: n }, (_, i) => i);
  if (walk === 'list-ordered') return Array.from({ length: n }, (_, i) => i * NODE_WORDS);
  const next = makeCycle(n, seed), out: number[] = [];
  for (let i = 0, at = 0; i < n; i++, at = next[at]) out.push(at * NODE_WORDS);
  return out;
}

export type CacheResult = { steps: number; hits: number; misses: number; outcome: boolean[]; ns: number };

/** A cold cache, fully associative, least recently used out first. outcome[i] is true for a hit. */
export function simulate(addrs: number[], lineWords = LINE_WORDS, lines = CACHE_LINES): CacheResult {
  // A Map remembers insertion order, so delete-and-set keeps it in recency order
  // and the first key is always the one to evict.
  const cache = new Map<number, true>();
  const outcome: boolean[] = [];
  let hits = 0, misses = 0;
  for (const a of addrs) {
    const line = Math.floor(a / lineWords);
    if (cache.has(line)) { hits++; outcome.push(true); cache.delete(line); }
    else {
      misses++; outcome.push(false);
      if (cache.size === lines) cache.delete(cache.keys().next().value!);
    }
    cache.set(line, true);
  }
  return { steps: addrs.length, hits, misses, outcome, ns: hits * HIT_NS + misses * MISS_NS };
}

export type LayoutRun = { walk: Walk; n: number; hits: number; misses: number; ns: number };
export function walkRun(walk: Walk, n: number): LayoutRun & { addrs: number[]; outcome: boolean[] } {
  const addrs = addresses(walk, n), r = simulate(addrs);
  return { walk, n, hits: r.hits, misses: r.misses, ns: r.ns, addrs, outcome: r.outcome };
}

/** The largest slider size at which scattering the nodes costs nothing yet: the whole list still fits in the cache. */
export function tippingSize(): number {
  let best = 0;
  for (let n = MIN_SIZE; n <= MAX_SIZE; n += SIZE_STEP) {
    if (walkRun('list-shuffled', n).misses === walkRun('list-ordered', n).misses) best = n;
    else break;
  }
  return best;
}

export type LayoutState = { runs: LayoutRun[] };
const at = (s: LayoutState, walk: Walk, n: number) => s.runs.find((r) => r.walk === walk && r.n === n);

export const LAYOUT_MISSION: Mission<LayoutState> = {
  id: 'alg-layout-tipping', title: 'Same steps, different bill', xp: 60,
  setup: () => ({ runs: [] }),
  steps: [
    { text: 'Walk the array, then the in-order linked list, at the same size. Same number of steps. Why does the list miss more?', hint: 'Pick each walk in turn and press Walk. A node is twice the size of an array slot', done: (s) => s.runs.some((r) => r.walk === 'array' && !!at(s, 'list-ordered', r.n)) },
    { text: 'Now scatter the nodes, same size again. Same data, same steps, same big-O. Compare the misses', hint: 'Use a big size, such as 512, and pick "nodes scattered"', done: (s) => s.runs.some((r) => { const o = r.walk === 'list-shuffled' ? at(s, 'list-ordered', r.n) : undefined; return !!o && r.misses > o.misses; }) },
    { text: 'Find the largest size where scattering still costs nothing extra: the misses match the in-order list, and one notch bigger they do not', hint: 'Halve the size until the two match, then creep up. The whole list has to fit in the cache', done: (s) => {
      const tip = tippingSize();
      return !!at(s, 'list-shuffled', tip) && !!at(s, 'list-shuffled', tip + SIZE_STEP) && !!at(s, 'list-ordered', tip) && !!at(s, 'list-ordered', tip + SIZE_STEP);
    } },
  ],
  debrief: 'Big-O calls all three walks O(n), and it is right: they take the same number of steps. It does not see where those steps land. While the data fits in the cache, layout hardly matters. Past that point every scattered read can be a trip to main memory. That is the shape in the table above: 1.1x at 1,000 elements and 56x at 64 million on one laptop. Your own machine is in the panel below, and it will not be the same.',
};

// ---- Python's list -------------------------------------------------------

export type GrowthRule = 'cpython' | '1.5x' | 'doubling';
export const RULES: { id: GrowthRule; label: string }[] = [
  { id: 'cpython', label: 'CPython: about 1.125x' },
  { id: '1.5x', label: 'Grow by half' },
  { id: 'doubling', label: 'Doubling' },
];

/**
 * The capacity after a resize forced by appending item number `size`. CPython's
 * line is copied from Objects/listobject.c, 3.9 onwards. It only holds for append:
 * `[0] * n` and extend take other paths, so the test compares append alone.
 */
export function nextCapacity(rule: GrowthRule, size: number, cap: number): number {
  if (rule === 'cpython') return (size + (size >> 3) + 6) & ~3;
  if (cap === 0) return 1;
  return rule === 'doubling' ? cap * 2 : Math.max(cap + 1, Math.floor(cap * 1.5));
}

export type Growth = { n: number; capacity: number; resizes: number; copies: number; copiesPerAppend: number; slackPct: number; jumps: [number, number][] };

/**
 * The state after n appends. Copies assume every resize moves everything, which
 * is an upper bound: CPython calls realloc, which may grow in place. Nothing in
 * ordinary Python says when it did. ctypes can read the list's data pointer and show
 * it, and how many resizes move varies by system and by run, so the count stays a bound.
 */
export function growthAfter(rule: GrowthRule, n: number): Growth {
  let cap = 0, resizes = 0, copies = 0;
  const jumps: [number, number][] = [];
  // Jumping from resize to resize keeps 10,000,000 appends instant in a browser.
  while (cap < n) {
    const size = cap + 1;
    copies += cap;
    resizes++;
    cap = nextCapacity(rule, size, cap);
    jumps.push([size, cap]);
  }
  return { n, capacity: cap, resizes, copies, copiesPerAppend: n ? copies / n : 0, slackPct: n ? (100 * (cap - n)) / n : 0, jumps };
}
